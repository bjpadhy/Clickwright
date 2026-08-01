/**
 * Changelog — the Observe → "Changelog" tab. One stream merging schema changes
 * with context versions, each entry linking back to the trace that produced it.
 *
 * Everything is derived from two tables we already write: context_store (who
 * changed which definition, when, and why) and runs_log (which run created which
 * tables, who approved it, and its trace URL). No new storage.
 *
 * The assembly is a pure function over rows so the correlation logic — which is
 * where the bugs live — is unit-testable without a database.
 */
import { query } from "../core/db.js";

// ── types ────────────────────────────────────────────────────────

export interface ContextRow {
  runId: string;
  sourceSpec: string;
  entity: string;
  version: number;
  changeNote: string;
  updatedAt: string;
}

export interface RunLogRow {
  runId: string;
  at: string;
  type: string;
  name: string;
  payload: Record<string, unknown>;
  /** runs_log.spec — empty for rows written before the column was added. */
  spec?: string;
}

export interface ChangelogEntry {
  id: string;
  at: string;
  kind: "table" | "context";
  title: string;
  description: string;
  /** An existing definition was replaced — the UI's "contradiction surfaced" badge. */
  warn: boolean;
  traceUrl: string | null;
  runId: string | null;
  spec: string | null;
  contextVersion: string | null;
  entities: string[];
  tables: Array<{ name: string; rows: number }>;
}

// ── pure helpers ─────────────────────────────────────────────────

/**
 * The UI shows one global "context v1.3" but context_store versions are per
 * entity — table:foo can be at v2 while metric:bar is at v5. A run writes all its
 * entries in one batch sharing a run_id, so batches ordered by time give a global
 * sequence: batch 0 (the base_context.md seed) is v1.0, then v1.1, v1.2…
 */
export function formatContextVersion(batchIndex: number): string {
  return `v${1 + Math.floor(batchIndex / 10)}.${batchIndex % 10}`;
}

/**
 * Uploaded specs land in uploads/<name>_<base36 timestamp>; sample specs are used
 * in place. Recover the name the user actually typed.
 */
export function specFromDir(specDir: string): string {
  const base = specDir.replace(/\/+$/, "").split("/").pop() ?? specDir;
  return specDir.includes("/uploads/") ? base.replace(/_[0-9a-z]{6,12}$/, "") : base;
}

function describeContextBatch(rows: ContextRow[]): string {
  const created = rows.filter((r) => r.version === 1);
  const superseded = rows.filter((r) => r.version > 1);
  const parts: string[] = [];
  if (created.length > 0) {
    parts.push(`+${created.length} new ${created.length === 1 ? "entry" : "entries"}`);
  }
  if (superseded.length > 0) {
    parts.push(
      `${superseded.length} existing ${superseded.length === 1 ? "definition" : "definitions"} superseded`,
    );
  }
  const named = [...superseded, ...created].slice(0, 3).map((r) => r.entity);
  if (named.length > 0) parts.push(named.join(", "));
  return parts.join(" · ");
}

function describeTables(tables: Array<{ name: string; rows: number }>): string {
  const [first] = tables;
  if (!first) return "no tables created";
  const rest = tables.length - 1;
  const head = rest > 0 ? `${first.name} + ${rest} more` : first.name;
  return `${head} created`;
}

interface RunFacts {
  runId: string;
  traceUrl: string | null;
  identity: string | null;
  spec: string | null;
  succeededAt: string | null;
  tables: Array<{ name: string; rows: number }>;
}

/** Collapse a run's event rows into the handful of facts the changelog needs. */
export function summariseRuns(runRows: RunLogRow[]): Map<string, RunFacts> {
  const runs = new Map<string, RunFacts>();
  const factsFor = (runId: string): RunFacts => {
    let facts = runs.get(runId);
    if (!facts) {
      facts = { runId, traceUrl: null, identity: null, spec: null, succeededAt: null, tables: [] };
      runs.set(runId, facts);
    }
    return facts;
  };

  for (const row of runRows) {
    const facts = factsFor(row.runId);

    // Prefer the spec column; rows predating it fall back to the specDir below.
    if (row.spec) facts.spec = row.spec;

    if (!facts.spec && row.type === "step_start" && row.name === "instrumentation") {
      const input = row.payload["input"];
      const specDir =
        typeof input === "object" && input !== null
          ? (input as Record<string, unknown>)["specDir"]
          : undefined;
      if (typeof specDir === "string") facts.spec = specFromDir(specDir);
    }

    if (row.type === "status" && row.name === "running") {
      const url = row.payload["traceUrl"];
      if (typeof url === "string" && url) facts.traceUrl = url;
    }

    if (row.type === "approval_result") {
      const identity = row.payload["identity"];
      if (typeof identity === "string" && identity) facts.identity = identity;
    }

    if (row.type === "status" && row.name === "succeeded") {
      facts.succeededAt = row.at;
      const tables = row.payload["tables"];
      if (Array.isArray(tables)) {
        facts.tables = tables.flatMap((t) => {
          if (typeof t !== "object" || t === null) return [];
          const record = t as Record<string, unknown>;
          const name = record["name"];
          if (typeof name !== "string") return [];
          return [{ name, rows: Number(record["rowsLoaded"] ?? 0) || 0 }];
        });
      }
    }
  }

  return runs;
}

/**
 * Merge context batches and run milestones into one reverse-chronological stream.
 *
 * Note the two sources are correlated by run_id but neither is authoritative on
 * its own: reset-spec.ts deletes a run's context rows while leaving runs_log
 * intact, so a succeeded run may have no matching context batch. The spec name
 * therefore comes from the run's specDir, not from the batch's source_spec.
 */
export function buildChangelog(
  contextRows: ContextRow[],
  runRows: RunLogRow[],
): ChangelogEntry[] {
  const runs = summariseRuns(runRows);

  // Group context rows into write batches, ordered by when the batch landed.
  const batches = new Map<string, ContextRow[]>();
  for (const row of [...contextRows].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))) {
    const existing = batches.get(row.runId);
    if (existing) existing.push(row);
    else batches.set(row.runId, [row]);
  }

  const entries: ChangelogEntry[] = [];

  let batchIndex = 0;
  for (const [runId, rows] of batches) {
    const first = rows[0];
    if (!first) continue;
    const version = formatContextVersion(batchIndex);
    batchIndex++;
    const run = runs.get(runId);
    entries.push({
      id: `ctx:${runId}`,
      at: first.updatedAt,
      kind: "context",
      title: `context ${version}`,
      description: describeContextBatch(rows),
      warn: rows.some((r) => r.version > 1),
      traceUrl: run?.traceUrl ?? null,
      runId: runId === "seed" || runId === "data_audit" ? null : runId,
      spec: run?.spec ?? first.sourceSpec,
      contextVersion: version,
      entities: rows.map((r) => r.entity),
      tables: [],
    });
  }

  for (const facts of runs.values()) {
    if (!facts.succeededAt || facts.tables.length === 0) continue;
    const totalRows = facts.tables.reduce((sum, t) => sum + t.rows, 0);
    const approver = facts.identity ? `approved by ${facts.identity}` : "auto-approved";
    entries.push({
      id: `tables:${facts.runId}`,
      at: facts.succeededAt,
      kind: "table",
      title: describeTables(facts.tables),
      description:
        `Instrumentation Agent · ${approver} · ` +
        `${totalRows.toLocaleString("en-US")} events loaded across ` +
        `${facts.tables.length} ${facts.tables.length === 1 ? "table" : "tables"}`,
      warn: false,
      traceUrl: facts.traceUrl,
      runId: facts.runId,
      spec: facts.spec,
      contextVersion: null,
      entities: [],
      tables: facts.tables,
    });
  }

  return entries.sort((a, b) => b.at.localeCompare(a.at));
}

export function changelogToMarkdown(entries: ChangelogEntry[]): string {
  const lines = [
    "# Clickwright changelog",
    "",
    "Every schema change and context update, newest first. Generated from",
    "`context_store` and `runs_log`.",
    "",
  ];
  for (const entry of entries) {
    const kind = entry.kind === "context" ? "context" : "schema";
    lines.push(`## ${entry.at} — ${entry.title}`);
    lines.push("");
    lines.push(`- **kind:** ${kind}`);
    if (entry.spec) lines.push(`- **spec:** ${entry.spec}`);
    lines.push(`- **detail:** ${entry.description}`);
    if (entry.warn) lines.push("- **contradiction surfaced:** an existing definition was replaced");
    if (entry.traceUrl) lines.push(`- **trace:** ${entry.traceUrl}`);
    if (entry.entities.length > 0) {
      lines.push(`- **entities:** ${entry.entities.join(", ")}`);
    }
    if (entry.tables.length > 0) {
      lines.push(
        `- **tables:** ${entry.tables.map((t) => `${t.name} (${t.rows.toLocaleString("en-US")} rows)`).join(", ")}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ── collectors ───────────────────────────────────────────────────

export async function loadContextRows(): Promise<ContextRow[]> {
  // definition_md is deliberately excluded — it is large and the changelog only
  // needs the metadata.
  const rows = await query<Record<string, unknown>>(`
    SELECT run_id, source_spec, entity, toUInt32(version) AS version,
           change_note, toString(updated_at) AS updated_at
    FROM context_store ORDER BY updated_at ASC, entity ASC
  `);
  return rows.map((r) => ({
    runId: String(r["run_id"] ?? ""),
    sourceSpec: String(r["source_spec"] ?? ""),
    entity: String(r["entity"] ?? ""),
    version: Number(r["version"] ?? 1) || 1,
    changeNote: String(r["change_note"] ?? ""),
    updatedAt: String(r["updated_at"] ?? ""),
  }));
}

export async function loadRunRows(): Promise<RunLogRow[]> {
  const rows = await query<Record<string, unknown>>(`
    SELECT run_id, spec, toString(ts) AS at, type, name, payload
    FROM runs_log
    WHERE (type = 'status' AND name IN ('running', 'succeeded', 'failed'))
       OR type = 'approval_result'
       OR (type = 'step_start' AND name = 'instrumentation')
    ORDER BY ts ASC
  `);
  return rows.map((r) => {
    let payload: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(String(r["payload"] ?? "{}"));
      if (typeof parsed === "object" && parsed !== null) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      payload = {};
    }
    return {
      runId: String(r["run_id"] ?? ""),
      at: String(r["at"] ?? ""),
      type: String(r["type"] ?? ""),
      name: String(r["name"] ?? ""),
      payload,
      spec: String(r["spec"] ?? ""),
    };
  });
}

export async function getChangelog(): Promise<ChangelogEntry[]> {
  const [contextRows, runRows] = await Promise.all([loadContextRows(), loadRunRows()]);
  return buildChangelog(contextRows, runRows);
}
