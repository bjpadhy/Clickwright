/**
 * Access layer for system.query_log.
 *
 * Two things make this less trivial than "SELECT FROM system.query_log":
 *
 * 1. On ClickHouse Cloud the log is per replica. Measured on our service, the
 *    local table saw 63,395 queries in 24h while clusterAllReplicas saw 127,116
 *    — reading the local table silently halves every number on the page. We
 *    probe for the clustered form once and fall back if it is unavailable.
 * 2. The observability endpoints query the log, and those queries are themselves
 *    logged. Without excluding them the page counts itself and the numbers climb
 *    on every refresh. Everything under withQueryContext({agent:"observe"}) is
 *    filtered out by the shared predicate below.
 */
import { query } from "../core/db.js";
import { env } from "../core/env.js";

export interface QueryLogSource {
  /** Table expression to SELECT from. */
  expr: string;
  /** False when the log cannot be read at all — callers must report "unavailable"
   *  rather than rendering zeros as if they were measurements. */
  available: boolean;
  /** True when reading the union across replicas. */
  clustered: boolean;
}

let cached: QueryLogSource | null = null;

async function readable(expr: string): Promise<boolean> {
  try {
    await query(`SELECT count() AS n FROM ${expr} WHERE event_time >= now() - INTERVAL 1 MINUTE`);
    return true;
  } catch {
    return false;
  }
}

export async function queryLogSource(): Promise<QueryLogSource> {
  if (cached) return cached;
  const clustered = `clusterAllReplicas('${env.clickhouse.cluster}', system.query_log)`;
  if (await readable(clustered)) {
    cached = { expr: clustered, available: true, clustered: true };
  } else if (await readable("system.query_log")) {
    cached = { expr: "system.query_log", available: true, clustered: false };
  } else {
    cached = { expr: "system.query_log", available: false, clustered: false };
  }
  return cached;
}

/** Test seam — the probe result is process-lifetime cached otherwise. */
export function resetQueryLogSource(): void {
  cached = null;
}

/**
 * The predicate every collector shares, so the stat cards, the latency chart and
 * the query lists are all describing the same population of queries.
 *
 * `has(databases, …)` rather than `current_database = …` is deliberate and was
 * measured: matching on current_database also admits ClickHouse Cloud's own
 * monitoring, which runs against system.* inside a session pointed at our
 * database. On our service that was 1,712 queries in 24h versus 646 that
 * actually touched the data — the looser filter more than doubles every stat
 * with queries no one on the team ran.
 *
 * Callers must not alias a column named `log_comment` in their SELECT: ClickHouse
 * resolves aliases inside WHERE, so `any(log_comment) AS log_comment` makes this
 * predicate reference the aggregate and the query fails.
 */
export function queryLogFilter(hours: number): string {
  const db = env.clickhouse.database;
  const window = Math.max(1, Math.floor(hours));
  return `type = 'QueryFinish'
    AND event_time >= now() - INTERVAL ${window} HOUR
    AND has(databases, '${db}')
    AND JSONExtractString(log_comment, 'agent') != 'observe'`;
}
