/**
 * Database health — the Observe → "Database health" tab.
 *
 * Everything here is measured from ClickHouse system tables; nothing is
 * estimated. When a system table is unavailable the field degrades to a null or
 * zero *with a flag*, because a fabricated number on an observability page is
 * worse than a gap.
 *
 * The SQL builders and row shapers are separated from the collectors so the
 * fiddly parts (dense hour buckets, spike detection, origin classification) are
 * pure functions with unit tests and no database in the loop.
 */
import { query } from "../core/db.js";
import { env } from "../core/env.js";
import { parseLogComment, type QueryAgent } from "../core/query-context.js";
import { queryLogFilter, queryLogSource } from "./query-log.js";

// ── types ────────────────────────────────────────────────────────

export type TableOrigin = "base" | "agent" | "internal";

export interface HealthStats {
  queries24h: number;
  p95LatencyMs: number;
  rowsRead24h: number;
  tablesLive: number;
  baseTables: number;
  agentTables: number;
}

export interface LatencyBucket {
  hourTs: number;
  hour: string;
  p95Ms: number;
  queries: number;
  isSpike: boolean;
  spikeCause: string | null;
}

export interface StorageRow {
  table: string;
  bytes: number;
  rows: number;
  parts: number;
  origin: TableOrigin;
}

export interface PartsHealth {
  activeParts: number;
  activeMerges: number;
  failedMerges24h: number;
  healthy: boolean;
  partLogAvailable: boolean;
}

export interface SlowQuery {
  shape: string;
  maxMs: number;
  runs: number;
  rows: number;
  agent: QueryAgent | null;
}

export interface RecentQuery {
  queryId: string;
  at: string;
  query: string;
  ms: number;
  rows: number;
  agent: QueryAgent | null;
  step: string | null;
  runId: string | null;
}

export const WINDOW_HOURS = 24;

/** ClickHouse serialises UInt64/Int64 as strings in JSONEachRow. */
function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

// ── pure helpers ─────────────────────────────────────────────────

/** Tables Clickwright owns for its own bookkeeping — real storage, but not data. */
const INTERNAL_TABLES = new Set(["context_store", "runs_log", "optimization_suggestions"]);

/** The 8 tables loaded before any agent ran. Only used if context_store is empty;
 *  normally origin comes from the context layer (see tableOrigins). */
const FALLBACK_BASE_TABLES = new Set([
  "destination_card_clicked",
  "application_started",
  "document_uploaded",
  "purchase_completed",
  "search_typed",
  "landing_page_scrolled",
  "auth_completed",
  "pay_now_clicked",
]);

export function classifyOrigin(
  table: string,
  baseTables: ReadonlySet<string>,
): TableOrigin {
  if (INTERNAL_TABLES.has(table)) return "internal";
  return baseTables.has(table) ? "base" : "agent";
}

export interface RawLatencyRow {
  hourTs: number;
  p95Ms: number;
  queries: number;
  topKind: string;
  topRows: number;
  topLogComment: string;
}

/**
 * ClickHouse only returns hours that had traffic, but the chart needs a dense
 * 24-slot series ending at the current hour. Anchoring on epoch seconds avoids
 * every timezone and separator mismatch between ClickHouse's
 * "2026-08-01 13:00:00" and JavaScript's ISO format.
 */
export function fillLatencyBuckets(
  rows: RawLatencyRow[],
  nowMs: number,
  hours: number = WINDOW_HOURS,
): Array<Omit<LatencyBucket, "isSpike" | "spikeCause"> & { raw: RawLatencyRow | null }> {
  const byHour = new Map(rows.map((r) => [r.hourTs, r]));
  const currentHourTs = Math.floor(nowMs / 3_600_000) * 3_600;
  const out: Array<
    Omit<LatencyBucket, "isSpike" | "spikeCause"> & { raw: RawLatencyRow | null }
  > = [];
  for (let i = hours - 1; i >= 0; i--) {
    const hourTs = currentHourTs - i * 3_600;
    const raw = byHour.get(hourTs) ?? null;
    out.push({
      hourTs,
      hour: new Date(hourTs * 1000).toISOString(),
      p95Ms: raw ? raw.p95Ms : 0,
      queries: raw ? raw.queries : 0,
      raw,
    });
  }
  return out;
}

/**
 * A bucket is a spike when its p95 is at least double the median busy hour. The
 * 100ms floor stops an idle service — where 4ms vs 2ms is "double" — from
 * flagging noise as an incident.
 */
export function markSpikes(
  buckets: Array<Omit<LatencyBucket, "isSpike" | "spikeCause"> & { raw: RawLatencyRow | null }>,
): LatencyBucket[] {
  const busy = buckets
    .filter((b) => b.queries > 0)
    .map((b) => b.p95Ms)
    .sort((a, b) => a - b);
  const median = busy.length > 0 ? (busy[Math.floor(busy.length / 2)] ?? 0) : 0;
  const threshold = Math.max(median * 2, 100);

  return buckets.map((b) => {
    const isSpike = median > 0 && b.queries > 0 && b.p95Ms >= threshold;
    return {
      hourTs: b.hourTs,
      hour: b.hour,
      p95Ms: b.p95Ms,
      queries: b.queries,
      isSpike,
      spikeCause: isSpike && b.raw ? describeSpike(b.raw) : null,
    };
  });
}

/** Human-readable attribution for the chart's spike annotation. */
export function describeSpike(raw: RawLatencyRow): string {
  const { agent } = parseLogComment(raw.topLogComment);
  const kind = raw.topKind.toLowerCase() || "query";
  const who = agent ? `${agent} ` : "";
  const rows = raw.topRows > 0 ? ` (${raw.topRows.toLocaleString("en-US")} rows)` : "";
  return `${who}${kind}${rows}`.trim();
}

export function truncateQuery(text: string, max = 240): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

// ── collectors ───────────────────────────────────────────────────

/**
 * Which tables predate the agents. Derived from the context layer rather than a
 * hard-coded list: a table:* entity whose FIRST version came from base_context.md
 * was there at seed time, anything else was created by a run. Stays correct as
 * specs are added.
 */
export async function tableOrigins(): Promise<Set<string>> {
  try {
    const rows = await query<{ entity: string; first_source: string }>(`
      SELECT entity, argMin(source_spec, version) AS first_source
      FROM context_store WHERE startsWith(entity, 'table:') GROUP BY entity
    `);
    const base = new Set(
      rows
        .filter((r) => r.first_source === "base_context.md")
        .map((r) => r.entity.slice("table:".length)),
    );
    return base.size > 0 ? base : new Set(FALLBACK_BASE_TABLES);
  } catch {
    return new Set(FALLBACK_BASE_TABLES);
  }
}

/**
 * Everything the page needs from system.query_log, read in ONE pass.
 *
 * The stat cards, the latency chart and the slow-query list each used to run
 * their own 24 h `clusterAllReplicas(system.query_log)` scan — three scans of
 * the same rows for one page load, on the deployment where that table is the
 * most expensive thing to read. GROUPING SETS gets all three groupings out of
 * a single scan: the grand total, one row per hour, and one row per query
 * shape.
 *
 * Rows are told apart without `grouping()` (whose 0/1 convention differs
 * between engines): a real hour is never epoch 0 and a real shape is never the
 * empty string, so `hour_ts = 0 AND shape = ''` is the totals row.
 */
export interface QueryLogWindow {
  /** True only when this window holds real measurements. False means nothing
   *  was measured — either there is no readable query_log at all, or the scan
   *  (and its fallback) failed — and the zeros below must not be reported as
   *  measurements. */
  available: boolean;
  /** Whether system.query_log itself is readable. Lets a caller tell "this
   *  deployment has no query log" (the query stats are honestly absent, the
   *  rest of the page still renders) from "the scan failed" (unmeasured). */
  sourceAvailable: boolean;
  /** True when the single-pass query worked; false means the per-collector
   *  fallback ran, which is correct but costs the extra scans. */
  combined: boolean;
  stats: { queries: number; p95Ms: number; rowsRead: number };
  hours: RawLatencyRow[];
  shapes: SlowQuery[];
}

/** The "no measurements" window: zeros with `available: false`, so callers
 *  report a gap instead of rendering zeros as if they were measured.
 *  `sourceAvailable` carries whether the query_log probe itself succeeded, so
 *  the caller can tell an absent log from a failed scan. */
export function emptyQueryLogWindow(sourceAvailable = false): QueryLogWindow {
  return {
    available: false,
    sourceAvailable,
    combined: false,
    stats: { queries: 0, p95Ms: 0, rowsRead: 0 },
    hours: [],
    shapes: [],
  };
}

/**
 * The query_log is readable but this window holds no measurements: the scan and
 * its fallback both failed. Callers must report a gap (null stats, empty series)
 * rather than the zeros the window carries.
 */
export function queryLogScanFailed(window: QueryLogWindow): boolean {
  return window.sourceAvailable && !window.available;
}

/**
 * The shape column is truncated in SQL, not in TypeScript: it is what the UI
 * displays anyway, it caps the response at a few hundred bytes per shape, and
 * it means two queries identical for their first 240 characters count as the
 * same shape — which is the grouping a "heaviest shapes" list wants.
 */
const SHAPE_EXPR =
  "substring(replaceRegexpAll(normalizeQuery(query), '\\s+', ' '), 1, 240)";

function shapeRow(r: Record<string, unknown>): SlowQuery {
  return {
    shape: truncateQuery(String(r["shape"] ?? "")),
    maxMs: num(r["max_ms"]),
    runs: num(r["queries"]),
    rows: num(r["max_rows"]),
    agent: parseLogComment(String(r["sample_log_comment"] ?? "")).agent,
  };
}

function hourRow(r: Record<string, unknown>): RawLatencyRow {
  return {
    hourTs: num(r["hour_ts"]),
    p95Ms: num(r["p95_ms"]),
    queries: num(r["queries"]),
    topKind: String(r["top_kind"] ?? ""),
    topRows: num(r["top_rows"]),
    topLogComment: String(r["top_log_comment"] ?? ""),
  };
}

/** Shared aggregate list — identical in the combined and fallback queries. */
const WINDOW_AGGREGATES = `
           count()                                                      AS queries,
           round(quantile(0.95)(query_duration_ms))                     AS p95_ms,
           sum(read_rows)                                               AS rows_read,
           max(query_duration_ms)                                       AS max_ms,
           max(greatest(read_rows, written_rows))                       AS max_rows,
           argMax(query_kind, query_duration_ms)                        AS top_kind,
           argMax(greatest(read_rows, written_rows), query_duration_ms)  AS top_rows,
           argMax(log_comment, query_duration_ms)                       AS top_log_comment,
           any(log_comment)                                             AS sample_log_comment`;

export async function collectQueryLogWindow(slowest = 5): Promise<QueryLogWindow> {
  const source = await queryLogSource();
  if (!source.available) return emptyQueryLogWindow();

  const limit = Math.max(1, Math.floor(slowest));
  const byWorst = (a: SlowQuery, b: SlowQuery) => b.maxMs - a.maxMs;

  // The shape grouping set has one row per distinct query shape in 24h, which
  // is unbounded — the top-N has to be applied in SQL (as the old
  // collectSlowestQueries did with ORDER BY … LIMIT) or the server serialises
  // every shape. `LIMIT n BY` caps each grouping set separately: the totals row
  // is 1 and a 24h window spans at most 25 hour buckets, so only the shapes are
  // ever cut, and the ORDER BY means the ones cut are the fastest.
  const perGrouping = Math.max(limit, WINDOW_HOURS + 2);

  try {
    const rows = await query<Record<string, unknown>>(`
      SELECT *, hour_ts > 0 AS is_hour, shape != '' AS is_shape FROM (
        SELECT toUnixTimestamp(toStartOfHour(event_time)) AS hour_ts,
               ${SHAPE_EXPR}                              AS shape,
${WINDOW_AGGREGATES}
        FROM ${source.expr}
        WHERE ${queryLogFilter(WINDOW_HOURS)}
        GROUP BY GROUPING SETS ((), (hour_ts), (shape))
      )
      ORDER BY max_ms DESC
      LIMIT ${perGrouping} BY is_hour, is_shape
    `);

    const window: QueryLogWindow = {
      available: true,
      sourceAvailable: true,
      combined: true,
      stats: { queries: 0, p95Ms: 0, rowsRead: 0 },
      hours: [],
      shapes: [],
    };
    for (const r of rows) {
      const hourTs = num(r["hour_ts"]);
      const shape = String(r["shape"] ?? "");
      if (hourTs > 0) window.hours.push(hourRow(r));
      else if (shape) window.shapes.push(shapeRow(r));
      else {
        window.stats = {
          queries: num(r["queries"]),
          p95Ms: num(r["p95_ms"]),
          rowsRead: num(r["rows_read"]),
        };
      }
    }
    window.hours.sort((a, b) => a.hourTs - b.hourTs);
    window.shapes = window.shapes.sort(byWorst).slice(0, limit);
    return window;
  } catch (error) {
    // GROUPING SETS is the only exotic thing on this page. If a deployment
    // rejects it, fall back to the original per-collector queries rather than
    // blanking the whole tab — slower, but the numbers are the same.
    console.warn(
      "[observe] single-pass query_log scan unavailable, falling back:",
      error instanceof Error ? error.message : error,
    );
    const [totals, hours, shapes] = await Promise.all([
      query<Record<string, unknown>>(`
        SELECT count()                                  AS queries,
               round(quantile(0.95)(query_duration_ms)) AS p95_ms,
               sum(read_rows)                           AS rows_read
        FROM ${source.expr} WHERE ${queryLogFilter(WINDOW_HOURS)}
      `),
      query<Record<string, unknown>>(`
        SELECT toUnixTimestamp(toStartOfHour(event_time))                    AS hour_ts,
               round(quantile(0.95)(query_duration_ms))                      AS p95_ms,
               count()                                                       AS queries,
               argMax(query_kind, query_duration_ms)                         AS top_kind,
               argMax(greatest(read_rows, written_rows), query_duration_ms)  AS top_rows,
               argMax(log_comment, query_duration_ms)                        AS top_log_comment
        FROM ${source.expr} WHERE ${queryLogFilter(WINDOW_HOURS)}
        GROUP BY hour_ts ORDER BY hour_ts ASC
      `),
      query<Record<string, unknown>>(`
        SELECT ${SHAPE_EXPR}                          AS shape,
               max(query_duration_ms)                 AS max_ms,
               count()                                AS queries,
               max(greatest(read_rows, written_rows)) AS max_rows,
               any(log_comment)                       AS sample_log_comment
        FROM ${source.expr} WHERE ${queryLogFilter(WINDOW_HOURS)}
        GROUP BY shape ORDER BY max_ms DESC LIMIT ${limit}
      `),
    ]);
    const row = totals[0];
    return {
      available: true,
      sourceAvailable: true,
      combined: false,
      stats: {
        queries: num(row?.["queries"]),
        p95Ms: num(row?.["p95_ms"]),
        rowsRead: num(row?.["rows_read"]),
      },
      hours: hours.map(hourRow),
      shapes: shapes.map(shapeRow),
    };
  }
}

export async function collectStats(
  baseTables: ReadonlySet<string>,
  window: QueryLogWindow,
): Promise<HealthStats> {
  const { queries: queries24h, p95Ms: p95LatencyMs, rowsRead: rowsRead24h } = window.stats;

  const tables = await query<{ name: string }>(`
    SELECT name FROM system.tables
    WHERE database = '${env.clickhouse.database}' AND NOT is_temporary
  `);
  const visible = tables
    .map((t) => t.name)
    .filter((n) => !n.startsWith(".inner") && !INTERNAL_TABLES.has(n));

  const baseCount = visible.filter((n) => baseTables.has(n)).length;

  return {
    queries24h,
    p95LatencyMs,
    rowsRead24h,
    tablesLive: visible.length,
    baseTables: baseCount,
    agentTables: visible.length - baseCount,
  };
}

/** Pure shaping of the shared window's hourly rows into the chart's series. */
export function collectLatency(nowMs: number, window: QueryLogWindow): LatencyBucket[] {
  return markSpikes(fillLatencyBuckets(window.hours, nowMs));
}

export async function collectStorage(
  baseTables: ReadonlySet<string>,
): Promise<{ tables: StorageRow[]; totalBytes: number }> {
  const rows = await query<Record<string, unknown>>(`
    SELECT table,
           sum(bytes_on_disk) AS bytes,
           sum(rows)          AS rows,
           count()            AS parts
    FROM system.parts
    WHERE database = '${env.clickhouse.database}' AND active
    GROUP BY table ORDER BY bytes DESC
  `);

  const tables: StorageRow[] = rows.map((r) => {
    const table = String(r["table"] ?? "");
    return {
      table,
      bytes: num(r["bytes"]),
      rows: num(r["rows"]),
      parts: num(r["parts"]),
      origin: classifyOrigin(table, baseTables),
    };
  });

  return { tables, totalBytes: tables.reduce((sum, t) => sum + t.bytes, 0) };
}

export async function collectPartsHealth(): Promise<PartsHealth> {
  const db = env.clickhouse.database;

  const [parts] = await query<Record<string, unknown>>(
    `SELECT count() AS n FROM system.parts WHERE database = '${db}' AND active`,
  );
  const activeParts = num(parts?.["n"]);

  let activeMerges = 0;
  try {
    const [merges] = await query<Record<string, unknown>>(
      `SELECT count() AS n FROM system.merges WHERE database = '${db}'`,
    );
    activeMerges = num(merges?.["n"]);
  } catch {
    activeMerges = 0;
  }

  // system.part_log is not guaranteed to exist on every deployment tier.
  let failedMerges24h = 0;
  let partLogAvailable = true;
  try {
    const [failures] = await query<Record<string, unknown>>(`
      SELECT countIf(error != 0) AS failed FROM system.part_log
      WHERE database = '${db}' AND event_time >= now() - INTERVAL ${WINDOW_HOURS} HOUR
    `);
    failedMerges24h = num(failures?.["failed"]);
  } catch {
    partLogAvailable = false;
  }

  return {
    activeParts,
    activeMerges,
    failedMerges24h,
    healthy: failedMerges24h === 0 && activeMerges < 10,
    partLogAvailable,
  };
}

/**
 * Heaviest query shapes, already grouped and ranked by the shared window scan
 * — one heavy query run five times is one row, not five identical ones.
 *
 * (Note for anyone editing the SQL upstream: a log_comment alias must NOT be
 * called `log_comment`. ClickHouse resolves SELECT aliases inside WHERE, and
 * the shared filter references that column, so the alias would turn it into
 * "aggregate function in WHERE" and fail.)
 */
export function collectSlowestQueries(window: QueryLogWindow): SlowQuery[] {
  return window.shapes;
}

export async function collectRecentQueries(limit = 20): Promise<RecentQuery[]> {
  const source = await queryLogSource();
  if (!source.available) return [];

  const rows = await query<Record<string, unknown>>(`
    SELECT query_id,
           toString(event_time)              AS at,
           query_duration_ms                 AS ms,
           greatest(read_rows, written_rows) AS rows,
           log_comment,
           substring(replaceRegexpAll(query, '\\\\s+', ' '), 1, 240) AS q
    FROM ${source.expr}
    WHERE ${queryLogFilter(WINDOW_HOURS)}
    ORDER BY event_time DESC LIMIT ${Math.floor(limit)}
  `);

  return rows.map((r) => {
    const parsed = parseLogComment(String(r["log_comment"] ?? ""));
    return {
      queryId: String(r["query_id"] ?? ""),
      at: String(r["at"] ?? ""),
      query: truncateQuery(String(r["q"] ?? "")),
      ms: num(r["ms"]),
      rows: num(r["rows"]),
      agent: parsed.agent,
      step: parsed.step,
      runId: parsed.runId,
    };
  });
}
