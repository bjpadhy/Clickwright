import {
  createClient,
  type ClickHouseClient,
  type ClickHouseSettings,
} from "@clickhouse/client";
import { env } from "./env.js";
import { buildLogComment, currentQueryContext } from "./query-context.js";

/**
 * Every statement carries a log_comment naming the agent that issued it, so
 * system.query_log can attribute work after the fact. See query-context.ts.
 */
function tagged(extra: ClickHouseSettings = {}): ClickHouseSettings {
  return { ...extra, log_comment: buildLogComment(currentQueryContext()) };
}

let client: ClickHouseClient | null = null;

export function db(): ClickHouseClient {
  client ??= createClient({
    url: env.clickhouse.url,
    username: env.clickhouse.username,
    password: env.clickhouse.password,
    database: env.clickhouse.database,
    request_timeout: 120_000,
    // A query that returns nothing for 120s looks dead to Cloud's load balancer,
    // which closes the socket — the answer is lost to "socket hang up" even
    // though ClickHouse is still working. Progress headers keep the connection
    // visibly alive. This only matters once scans get slow, which is exactly
    // what more data does.
    clickhouse_settings: {
      send_progress_in_http_headers: 1,
      http_headers_progress_interval_ms: "30000",
    },
  });
  return client;
}

/** Run a SELECT and get typed rows back. Use {name:Type} placeholders with
 * `params` for any user-supplied value — never string interpolation. */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: Record<string, unknown>,
): Promise<T[]> {
  return withTransientRetry(async () => {
    const result = await db().query({
      query: sql,
      format: "JSONEachRow",
      // Re-evaluated per attempt so a retry is tagged with the context that is
      // actually current, not the one captured when the first attempt started.
      clickhouse_settings: tagged(),
      ...(params ? { query_params: params } : {}),
    });
    return result.json<T>();
  });
}

/** Transient infrastructure failures (socket drops, TLS resets, timeouts) are
 * NOT the model's fault — retry the same statement instead of regenerating it. */
export function isTransientDbError(error: unknown): boolean {
  const m = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    m.includes("socket") ||
    m.includes("tls") ||
    m.includes("econnreset") ||
    m.includes("etimedout") ||
    m.includes("enotfound") ||
    m.includes("eai_again") ||
    m.includes("socket hang up") ||
    m.includes("network")
  );
}

async function withTransientRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let lastError: unknown;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientDbError(error) || i === tries) throw error;
      await new Promise((r) => setTimeout(r, 400 * i * i));
    }
  }
  throw lastError;
}

/** Read-only SELECT with a hard server-side guard: the analytics/chat path
 * physically cannot mutate anything, regardless of what SQL reaches it.
 * Transient network failures are retried transparently. */
export async function queryReadonly<T = Record<string, unknown>>(
  sql: string,
): Promise<T[]> {
  return withTransientRetry(async () => {
    const result = await db().query({
      query: sql,
      format: "JSONEachRow",
      // readonly=1 and log_comment coexist — verified against the live service.
      // The analytics agent runs the most interesting queries in the system; if
      // they were untagged they would show as unattributed on the Observe screen.
      clickhouse_settings: tagged({ readonly: "1", max_execution_time: 30 }),
    });
    return result.json<T>();
  });
}

/** Run a statement with no result set — DDL, INSERT ... SELECT, etc. */
export async function command(
  sql: string,
  params?: Record<string, unknown>,
): Promise<void> {
  await db().command({
    query: sql,
    clickhouse_settings: tagged({ wait_end_of_query: 1 }),
    ...(params ? { query_params: params } : {}),
  });
}

/** Insert rows into a table. Values are sent as JSONEachRow. */
export async function insert(
  table: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  if (rows.length === 0) return;
  await db().insert({
    table,
    values: rows,
    format: "JSONEachRow",
    clickhouse_settings: tagged({ date_time_input_format: "best_effort" }),
  });
}

/**
 * Run several statements in order. ClickHouse has no multi-statement queries,
 * so DDL scripts have to be split and sent one at a time.
 */
export async function commandBatch(statements: string[]): Promise<void> {
  for (const sql of statements) {
    const trimmed = sql.trim();
    if (trimmed) await command(trimmed);
  }
}

export async function tableExists(name: string): Promise<boolean> {
  const rows = await query<{ n: string }>(
    `SELECT count() AS n FROM system.tables
     WHERE database = '${env.clickhouse.database}' AND name = '${name}'`,
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

export async function rowCount(table: string): Promise<number> {
  const rows = await query<{ n: string }>(`SELECT count() AS n FROM ${table}`);
  return Number(rows[0]?.n ?? 0);
}

export async function closeDb(): Promise<void> {
  await client?.close();
  client = null;
}
