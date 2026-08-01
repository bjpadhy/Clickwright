/**
 * Optimization advisor — the "Optimization suggestions" card on the Database
 * health tab.
 *
 * Same discipline as the rest of the pipeline: the LLM decides what is worth
 * suggesting, but every figure it cites comes from measured evidence gathered by
 * pure code first. The model never queries the database and never estimates a
 * number. A suggestion naming a table that does not exist is rejected before it
 * is stored.
 *
 * Scans are on demand rather than nightly — a hackathon demo needs a button, not
 * a cron — but results are persisted so the card is populated on a cold load.
 */
import { z } from "zod";
import { command, insert, query } from "../core/db.js";
import { env } from "../core/env.js";
import { complete, loadPrompt, stripFences } from "../core/llm.js";
import { withQueryContext } from "../core/query-context.js";
import { endRun, flushTraces, startRun, step, traceUrl, type Ctx } from "../core/tracing.js";
import { queryLogFilter, queryLogSource } from "./query-log.js";
import { classifyOrigin, tableOrigins, type TableOrigin } from "./db-health.js";

// ── types ────────────────────────────────────────────────────────

export interface TableEvidence {
  table: string;
  origin: TableOrigin;
  bytes: number;
  rows: number;
  parts: number;
  sharePct: number;
  reads24h: number;
  reads30d: number;
}

export interface ShapeEvidence {
  shape: string;
  runs: number;
  maxMs: number;
  avgMs: number;
  rowsRead: number;
}

export interface AdvisorEvidence {
  windowHours: number;
  totalBytes: number;
  queryLogAvailable: boolean;
  tables: TableEvidence[];
  topShapes: ShapeEvidence[];
  materializedViews: string[];
  /**
   * How long ago the oldest active part was written. Critical context: on a
   * database created this morning, "0 reads in 30 days" says nothing about
   * whether a table is cold — it says the database is younger than the window.
   * Without this the advisor confidently recommends TTLs on day-old data.
   */
  oldestDataAgeHours: number | null;
}

export interface Suggestion {
  id: string;
  severity: "HIGH" | "MED" | "GOOD";
  action: string;
  why: string;
  targetTable: string | null;
  actionable: boolean;
  scannedAt: string;
}

export type ScanStatus = "never_run" | "scanning" | "ready" | "failed";

export interface ScanResult {
  status: ScanStatus;
  scannedAt: string | null;
  traceUrl: string | null;
  suggestions: Suggestion[];
  error?: string;
}

const READS_WINDOW_HOURS = 720; // 30 days

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

// ── evidence (pure measurement, no LLM) ──────────────────────────

/** Strip the `database.` prefix ClickHouse puts on system.query_log's `tables`. */
export function stripDatabasePrefix(qualified: string, database: string): string {
  return qualified.startsWith(`${database}.`)
    ? qualified.slice(database.length + 1)
    : qualified;
}

export async function gatherEvidence(): Promise<AdvisorEvidence> {
  const db = env.clickhouse.database;
  const source = await queryLogSource();
  const baseTables = await tableOrigins();

  const storage = await query<Record<string, unknown>>(`
    SELECT table, sum(bytes_on_disk) AS bytes, sum(rows) AS rows, count() AS parts
    FROM system.parts WHERE database = '${db}' AND active
    GROUP BY table ORDER BY bytes DESC
  `);

  const reads24h = new Map<string, number>();
  const reads30d = new Map<string, number>();
  if (source.available) {
    for (const [target, hours] of [
      [reads24h, 24],
      [reads30d, READS_WINDOW_HOURS],
    ] as const) {
      const rows = await query<Record<string, unknown>>(`
        SELECT arrayJoin(tables) AS qualified, count() AS reads
        FROM ${source.expr} WHERE ${queryLogFilter(hours)}
        GROUP BY qualified
      `);
      for (const row of rows) {
        const table = stripDatabasePrefix(String(row["qualified"] ?? ""), db);
        target.set(table, num(row["reads"]));
      }
    }
  }

  const totalBytes = storage.reduce((sum, r) => sum + num(r["bytes"]), 0);
  const tables: TableEvidence[] = storage.map((r) => {
    const table = String(r["table"] ?? "");
    const bytes = num(r["bytes"]);
    return {
      table,
      origin: classifyOrigin(table, baseTables),
      bytes,
      rows: num(r["rows"]),
      parts: num(r["parts"]),
      sharePct: totalBytes > 0 ? Math.round((bytes / totalBytes) * 1000) / 10 : 0,
      reads24h: reads24h.get(table) ?? 0,
      reads30d: reads30d.get(table) ?? 0,
    };
  });

  let topShapes: ShapeEvidence[] = [];
  if (source.available) {
    const rows = await query<Record<string, unknown>>(`
      SELECT normalizeQuery(query)          AS shape,
             count()                        AS runs,
             max(query_duration_ms)         AS max_ms,
             round(avg(query_duration_ms))  AS avg_ms,
             sum(read_rows)                 AS rows_read
      FROM ${source.expr} WHERE ${queryLogFilter(READS_WINDOW_HOURS)}
      GROUP BY shape ORDER BY runs * avg_ms DESC LIMIT 8
    `);
    topShapes = rows.map((r) => ({
      shape: String(r["shape"] ?? "").replace(/\s+/g, " ").slice(0, 200),
      runs: num(r["runs"]),
      maxMs: num(r["max_ms"]),
      avgMs: num(r["avg_ms"]),
      rowsRead: num(r["rows_read"]),
    }));
  }

  const mvs = await query<{ name: string }>(`
    SELECT name FROM system.tables
    WHERE database = '${db}' AND engine = 'MaterializedView'
  `);

  let oldestDataAgeHours: number | null = null;
  try {
    const [age] = await query<Record<string, unknown>>(`
      SELECT round(dateDiff('hour', min(modification_time), now())) AS hours
      FROM system.parts WHERE database = '${db}' AND active
    `);
    oldestDataAgeHours = age ? num(age["hours"]) : null;
  } catch {
    oldestDataAgeHours = null;
  }

  return {
    windowHours: 24,
    totalBytes,
    queryLogAvailable: source.available,
    tables,
    topShapes,
    materializedViews: mvs.map((m) => m.name),
    oldestDataAgeHours,
  };
}

/** The evidence, rendered for the prompt. Kept tabular so the model can quote it. */
export function evidenceToMarkdown(evidence: AdvisorEvidence): string {
  const mb = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`;
  const lines: string[] = [];

  lines.push(`Total storage: ${mb(evidence.totalBytes)} across ${evidence.tables.length} tables.`);
  lines.push(
    evidence.queryLogAvailable
      ? "Read counts below are measured from system.query_log."
      : "WARNING: system.query_log is unavailable — read counts are all 0 and prove nothing. Do NOT claim any table is unused.",
  );

  if (evidence.oldestDataAgeHours !== null) {
    const hours = evidence.oldestDataAgeHours;
    const age =
      hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
    lines.push(
      `Oldest data in this database was written ${age} ago.` +
        (hours < 24 * 30
          ? ` NOTE: this is younger than the 30-day read window, so a low 30-day read count means the data has not existed for 30 days — it does NOT mean the table is cold. Do not argue for retention changes from read counts over a window longer than ${age}.`
          : ""),
    );
  }
  lines.push("");
  lines.push("## Tables");
  lines.push("| table | origin | size | share | rows | parts | reads 24h | reads 30d |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const t of evidence.tables) {
    lines.push(
      `| ${t.table} | ${t.origin} | ${mb(t.bytes)} | ${t.sharePct}% | ${t.rows.toLocaleString("en-US")} | ${t.parts} | ${t.reads24h} | ${t.reads30d} |`,
    );
  }

  lines.push("");
  lines.push("## Most expensive query shapes (30d, by runs × avg duration)");
  if (evidence.topShapes.length === 0) {
    lines.push("(none measured)");
  } else {
    lines.push("| runs | avg ms | max ms | rows read | shape |");
    lines.push("|---|---|---|---|---|");
    for (const s of evidence.topShapes) {
      lines.push(
        `| ${s.runs} | ${s.avgMs} | ${s.maxMs} | ${s.rowsRead.toLocaleString("en-US")} | \`${s.shape}\` |`,
      );
    }
  }

  lines.push("");
  lines.push(
    `## Materialized views\n${evidence.materializedViews.length > 0 ? evidence.materializedViews.join(", ") : "(none)"}`,
  );

  return lines.join("\n");
}

// ── LLM scan ─────────────────────────────────────────────────────

const ScanSchema = z.object({
  suggestions: z
    .array(
      z.object({
        severity: z.enum(["HIGH", "MED", "GOOD"]),
        action: z.string().min(10),
        why: z.string().min(30),
        targetTable: z.string().nullable(),
        actionable: z.boolean(),
      }),
    )
    .min(1)
    .max(6),
});

export type ScanProposal = z.infer<typeof ScanSchema>;

/**
 * Reject suggestions about tables that do not exist. The prompt asks the model to
 * quote measured figures, but a hallucinated table name is the failure mode that
 * would put a fabricated recommendation in front of a judge.
 */
export function validateAgainstEvidence(
  proposal: ScanProposal,
  evidence: AdvisorEvidence,
): void {
  const known = new Set(evidence.tables.map((t) => t.table));
  const phantom = proposal.suggestions
    .map((s) => s.targetTable)
    .filter((t): t is string => typeof t === "string" && t.length > 0 && !known.has(t));
  if (phantom.length > 0) {
    throw new Error(
      `Suggestions reference tables that do not exist: ${[...new Set(phantom)].join(", ")}. ` +
        `Valid tables: ${[...known].join(", ")}`,
    );
  }
}

export async function ensureSuggestionsTable(): Promise<void> {
  await command(`
    CREATE TABLE IF NOT EXISTS optimization_suggestions (
      scan_id      String,
      id           String,
      scanned_at   DateTime64(3),
      severity     LowCardinality(String),
      action       String,
      why          String,
      target_table String,
      actionable   UInt8,
      trace_url    String
    ) ENGINE = MergeTree ORDER BY (scanned_at, id)
    COMMENT 'Clickwright optimization advisor — one row per suggestion per scan'
  `);
}

const MAX_SCAN_ATTEMPTS = 3;

export async function runScan(): Promise<ScanResult> {
  const trace = startRun("advisor:optimization_scan", {}, { sessionId: "advisor" });
  const url = traceUrl(trace);

  try {
    const result = await withQueryContext({ agent: "observe" }, async () => {
      await ensureSuggestionsTable();

      const evidence = await step(trace, "advisor_evidence", {}, () => gatherEvidence());

      let feedback = "";
      for (let attempt = 1; attempt <= MAX_SCAN_ATTEMPTS; attempt++) {
        try {
          return await step(
            trace,
            `advisor_generation_attempt_${attempt}`,
            { feedback },
            async (span: Ctx) => {
              const prompt = await loadPrompt("optimization_scan", {
                evidence: evidenceToMarkdown(evidence),
                feedback: feedback
                  ? `\n# Feedback on your previous attempt — fix this\n${feedback}\n`
                  : "",
              });
              const text = await complete(span, "optimization_scan", prompt, {
                maxTokens: 4000,
              });
              const parsed = ScanSchema.parse(JSON.parse(stripFences(text)));
              validateAgainstEvidence(parsed, evidence);
              return persist(parsed, url);
            },
          );
        } catch (error) {
          feedback = `Your output was rejected: ${error instanceof Error ? error.message : String(error)}`;
          if (attempt === MAX_SCAN_ATTEMPTS) throw error;
        }
      }
      throw new Error("unreachable");
    });

    endRun(trace, { status: "success", suggestions: result.suggestions.length });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    endRun(trace, { status: "failed", error: message });
    return { status: "failed", scannedAt: null, traceUrl: url, suggestions: [], error: message };
  } finally {
    await flushTraces().catch(() => {});
  }
}

async function persist(proposal: ScanProposal, url: string): Promise<ScanResult> {
  const scanId = `scan_${Date.now().toString(36)}`;
  const now = new Date();
  const stamp = now.toISOString().replace("T", " ").replace("Z", "");

  const suggestions: Suggestion[] = proposal.suggestions.map((s, index) => ({
    id: `${scanId}_${index}`,
    severity: s.severity,
    action: s.action,
    why: s.why,
    targetTable: s.targetTable,
    // A "GOOD" finding is an observation, not a change to make — the UI hides
    // its "Ask agent to draft it" button.
    actionable: s.severity !== "GOOD" && s.actionable,
    scannedAt: now.toISOString(),
  }));

  await insert(
    "optimization_suggestions",
    suggestions.map((s) => ({
      scan_id: scanId,
      id: s.id,
      scanned_at: stamp,
      severity: s.severity,
      action: s.action,
      why: s.why,
      target_table: s.targetTable ?? "",
      actionable: s.actionable ? 1 : 0,
      trace_url: url,
    })),
  );

  return { status: "ready", scannedAt: now.toISOString(), traceUrl: url, suggestions };
}

/** The most recent scan, or never_run before the first one. */
export async function latestScan(): Promise<ScanResult> {
  await ensureSuggestionsTable();
  const rows = await query<Record<string, unknown>>(`
    SELECT id, severity, action, why, target_table, actionable, trace_url,
           toString(scanned_at) AS scanned_at
    FROM optimization_suggestions
    WHERE scan_id = (SELECT scan_id FROM optimization_suggestions ORDER BY scanned_at DESC LIMIT 1)
    ORDER BY
      multiIf(severity = 'HIGH', 0, severity = 'MED', 1, 2) ASC, id ASC
  `);

  if (rows.length === 0) {
    return { status: "never_run", scannedAt: null, traceUrl: null, suggestions: [] };
  }

  const first = rows[0];
  return {
    status: "ready",
    scannedAt: String(first?.["scanned_at"] ?? ""),
    traceUrl: String(first?.["trace_url"] ?? "") || null,
    suggestions: rows.map((r) => ({
      id: String(r["id"] ?? ""),
      severity: String(r["severity"] ?? "MED") as Suggestion["severity"],
      action: String(r["action"] ?? ""),
      why: String(r["why"] ?? ""),
      targetTable: String(r["target_table"] ?? "") || null,
      actionable: num(r["actionable"]) === 1,
      scannedAt: String(r["scanned_at"] ?? ""),
    })),
  };
}

export async function findSuggestion(id: string): Promise<Suggestion | null> {
  if (!/^[a-z0-9_]+$/i.test(id)) return null;
  const rows = await query<Record<string, unknown>>(`
    SELECT id, severity, action, why, target_table, actionable, toString(scanned_at) AS scanned_at
    FROM optimization_suggestions WHERE id = '${id}' ORDER BY scanned_at DESC LIMIT 1
  `);
  const row = rows[0];
  if (!row) return null;
  return {
    id: String(row["id"] ?? ""),
    severity: String(row["severity"] ?? "MED") as Suggestion["severity"],
    action: String(row["action"] ?? ""),
    why: String(row["why"] ?? ""),
    targetTable: String(row["target_table"] ?? "") || null,
    actionable: num(row["actionable"]) === 1,
    scannedAt: String(row["scanned_at"] ?? ""),
  };
}
