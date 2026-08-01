import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { env } from "./env.js";

let client: ClickHouseClient | null = null;

export function db(): ClickHouseClient {
  client ??= createClient({
    url: env.clickhouse.url,
    username: env.clickhouse.username,
    password: env.clickhouse.password,
    database: env.clickhouse.database,
    request_timeout: 120_000,
  });
  return client;
}

/** Run a SELECT and get typed rows back. */
export async function query<T = Record<string, unknown>>(
  sql: string,
): Promise<T[]> {
  const result = await db().query({ query: sql, format: "JSONEachRow" });
  return result.json<T>();
}

/** Run a statement with no result set — DDL, INSERT ... SELECT, etc. */
export async function command(sql: string): Promise<void> {
  await db().command({
    query: sql,
    clickhouse_settings: { wait_end_of_query: 1 },
  });
}

/** Insert rows into a table. Values are sent as JSONEachRow. */
export async function insert(
  table: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  if (rows.length === 0) return;
  await db().insert({ table, values: rows, format: "JSONEachRow" });
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
