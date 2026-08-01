/**
 * Dashboards (Boards screen): a saved insight chart is stored as its SQL, so
 * every load re-executes it against ClickHouse — the card is always fresh data,
 * never a cached picture. Guarded and read-only, same as chat SQL.
 */
import { randomUUID } from "node:crypto";
import { command, insert, query } from "../core/db.js";
import { queryReadonly } from "../core/db.js";
import { guardSql } from "../agents/analytics.js";

export async function initDashboardTables(): Promise<void> {
  await command(`
    CREATE TABLE IF NOT EXISTS dashboards (
      dash_id     String,
      title       String,
      sql         String,
      chart_kind  LowCardinality(String),
      meta_json   String,
      deleted     UInt8 DEFAULT 0,
      created_at  DateTime64(3)
    ) ENGINE = ReplacingMergeTree(created_at) ORDER BY dash_id
    COMMENT 'Saved visualizations; the artifact is the SQL, re-run on every load'
  `);
}

const now = () => new Date().toISOString().replace("T", " ").replace("Z", "");

export interface SaveDashboardInput {
  title: string;
  sql: string;
  chartKind?: "bar" | "line";
  meta?: Record<string, unknown>;
}

export async function saveDashboard(input: SaveDashboardInput): Promise<string> {
  const sql = guardSql(input.sql); // reject anything that isn't a read-only SELECT
  const id = `dash_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
  await insert("dashboards", [
    {
      dash_id: id,
      title: input.title,
      sql,
      chart_kind: input.chartKind ?? "bar",
      meta_json: JSON.stringify(input.meta ?? {}),
      deleted: 0,
      created_at: now(),
    },
  ]);
  return id;
}

export async function listDashboards(): Promise<unknown[]> {
  return query(`
    SELECT dash_id AS id, title, chart_kind AS chartKind, meta_json AS meta,
           toString(created_at) AS createdAt
    FROM dashboards WHERE deleted = 0 ORDER BY created_at DESC LIMIT 100
  `);
}

/** Re-execute the saved SQL — "saved SQL · re-ran <time> · fresh data". */
export async function runDashboard(id: string): Promise<unknown> {
  const rows = await query<{ title: string; sql: string; chart_kind: string; meta_json: string }>(
    `SELECT title, sql, chart_kind, meta_json FROM dashboards
     WHERE dash_id = {id:String} AND deleted = 0 ORDER BY created_at DESC LIMIT 1`,
    { id },
  );
  if (rows.length === 0) throw new Error("unknown dashboard");
  const d = rows[0]!;
  const t0 = Date.now();
  const result = await queryReadonly(guardSql(d.sql));
  const ms = Date.now() - t0;

  // shape the first string column as labels and first numeric as values
  const cols = Object.keys(result[0] ?? {});
  const labelCol = cols.find((c) => typeof result[0]?.[c] === "string") ?? cols[0];
  const valueCol =
    cols.find((c) => c !== labelCol && Number.isFinite(Number(result[0]?.[c]))) ?? cols[1];
  return {
    id,
    title: d.title,
    chartKind: d.chart_kind,
    meta: JSON.parse(d.meta_json || "{}") as unknown,
    ms,
    ranAt: new Date().toISOString(),
    rowCount: result.length,
    series:
      labelCol && valueCol
        ? result.slice(0, 50).map((r) => ({
            label: String(r[labelCol]),
            value: Number(r[valueCol]),
          }))
        : [],
    rows: result.slice(0, 50),
    sql: d.sql,
  };
}

export async function deleteDashboard(id: string): Promise<void> {
  const rows = await query<{ title: string; sql: string; chart_kind: string; meta_json: string }>(
    `SELECT title, sql, chart_kind, meta_json FROM dashboards
     WHERE dash_id = {id:String} ORDER BY created_at DESC LIMIT 1`,
    { id },
  );
  if (rows.length === 0) throw new Error("unknown dashboard");
  await insert("dashboards", [
    {
      dash_id: id,
      title: rows[0]!.title,
      sql: rows[0]!.sql,
      chart_kind: rows[0]!.chart_kind,
      meta_json: rows[0]!.meta_json,
      deleted: 1,
      created_at: now(),
    },
  ]);
}
