/**
 * ③ Analytics Agent — a PM question in, a cited Insight out. The chat backend.
 *
 * plan → SQL per task (guarded, read-only, self-healing ≤3) → sanity gate →
 * knowledge lookup → narrate → citation check (every number must exist in the
 * SQL results) → quality gate. One Langfuse trace per question.
 *
 * READ-ONLY BY CONSTRUCTION: context via getContext/lookupContext only (this
 * agent cannot call updateContext — it lacks an instrumentation result), and
 * SQL runs through queryReadonly (ClickHouse readonly=1) after code guards.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { command, insert, isTransientDbError, query, queryReadonly } from "../core/db.js";
import { withQueryContext } from "../core/query-context.js";
import { step, scoreRun, recordQuery, emitRunEvent, type Ctx } from "../core/tracing.js";
import { complete, loadPrompt, stripFences } from "../core/llm.js";
import { getContext, lookupContext, reconcileWithLive } from "./context.js";

// ── answer cache ────────────────────────────────────────────────
// A question whose wording and context version are unchanged has the same
// answer: serve it from ClickHouse in milliseconds instead of re-running the
// agent. Any context write changes contextVersion, which invalidates naturally.

export async function initInsightCache(): Promise<void> {
  await command(`
    CREATE TABLE IF NOT EXISTS insight_cache (
      cache_key     String,
      question      String,
      context_key   String,
      insight_json  String,
      created_at    DateTime64(3)
    ) ENGINE = ReplacingMergeTree(created_at) ORDER BY cache_key
    COMMENT 'Analytics answers keyed by question + context version — repeat asks are instant'
  `);
}

const cacheKey = (question: string, contextKey: string) =>
  createHash("sha256")
    .update(`${question.trim().toLowerCase().replace(/\s+/g, " ")}::${contextKey}`)
    .digest("hex")
    .slice(0, 32);

async function readCache(key: string): Promise<Insight | null> {
  const rows = await query<{ insight_json: string }>(
    `SELECT insight_json FROM insight_cache WHERE cache_key = {k:String}
     ORDER BY created_at DESC LIMIT 1`,
    { k: key },
  );
  if (rows.length === 0) return null;
  try {
    return JSON.parse(rows[0]!.insight_json) as Insight;
  } catch {
    return null;
  }
}

// ── output contract (mirrors backend/API.md `Insight`) ──────────

export interface Insight {
  headline: string;
  findings: Array<{ tag: "driver" | "segment" | "caveat" | "known_issue"; text: string }>;
  chart: null | {
    title: string;
    kind: "bar" | "line";
    series: Array<{ label: string; value: number }>;
    sourceTask: string;
    /** How to render `value` — derived in code, never asked of the model. */
    valueFormat?: string | undefined;
  };
  segmentTable: null | {
    columns: string[];
    rows: Array<Array<string | number>>;
    sourceTask: string;
    /** Per-column render hint, parallel to `columns`. */
    columnFormats?: string[] | undefined;
  };
  confidence: { value: "high" | "medium" | "low"; note: string };
  contextVersion: string;
  sql: Array<{ task: string; title: string; query: string; rowCount: number }>;
  /** True when served from insight_cache (no LLM calls, ~ms). */
  cached?: boolean;
}

const PlanSchema = z.object({
  approach: z.string().min(1),
  tasks: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9_]+$/i),
        title: z.string().min(1),
        question: z.string().min(1),
        tables: z.array(z.string()).min(1),
        dimensions: z.array(z.string()).optional(),
      }),
    )
    .max(4),
});
type Plan = z.infer<typeof PlanSchema>;

const NarrationSchema = z.object({
  headline: z.string().min(1),
  findings: z
    .array(
      z.object({
        tag: z.enum(["driver", "segment", "caveat", "known_issue"]),
        text: z.string().min(1),
      }),
    )
    .min(1)
    .max(6),
  chart: z
    .object({
      title: z.string(),
      kind: z.enum(["bar", "line"]),
      series: z.array(z.object({ label: z.string(), value: z.number() })).min(1).max(12),
      sourceTask: z.string(),
      valueFormat: z.string().optional(),
    })
    .nullish()
    .transform((v) => v ?? null),
  segmentTable: z
    .object({
      columns: z.array(z.string()).min(2),
      rows: z.array(z.array(z.union([z.string(), z.number()]))).min(1).max(8),
      sourceTask: z.string(),
      columnFormats: z.array(z.string()).optional(),
    })
    .nullish()
    .transform((v) => v ?? null),
  confidence: z.object({
    value: z.enum(["high", "medium", "low"]),
    note: z.string().min(1),
  }),
});
type Narration = z.infer<typeof NarrationSchema>;

const QualitySchema = z.object({
  actionable: z.boolean(),
  cites_numbers: z.boolean(),
  names_segment: z.boolean(),
  links_known_issue: z.boolean(),
  honest_confidence: z.boolean(),
  verdict: z.enum(["pass", "revise"]),
  revision_note: z.string(),
});

/** Exact column names+types per table. Injected into plan/SQL prompts: the
 * single biggest accuracy win — the model stops guessing column names, which
 * also removes most retry rounds (so it is a latency win too). */
async function tableSchemas(): Promise<Map<string, string>> {
  const rows = await query<{ table: string; cols: string }>(`
    SELECT table, arrayStringConcat(groupArray(concat(name, ' ', type)), ', ') AS cols
    FROM system.columns
    WHERE database = currentDatabase() AND table NOT IN (
      'context_store', 'runs_log', 'conversations', 'messages', 'dashboards',
      'insight_cache', 'optimization_suggestions', 'schema_changelog', 'trace_summaries'
    )
    GROUP BY table ORDER BY table
  `);
  return new Map(rows.map((r) => [r.table, `- ${r.table}: ${r.cols}`]));
}

/** Only the tables this step needs — a SQL prompt paying for 13 schemas when it
 * touches 2 is pure waste, and the noise hurts accuracy as well as cost. */
function schemaSubset(all: Map<string, string>, tables: string[]): string {
  const picked = tables.map((t) => all.get(t)).filter(Boolean) as string[];
  const lines = picked.length ? picked : [...all.values()];
  // Whether the hygiene columns exist is a FACT we already have. Stating it per
  // table beats asking the model to infer it — it filtered duplicate_id on a
  // table that lacks the column when left to a general rule.
  return lines
    .map((line) => {
      const has = /\bduplicate_id\b/.test(line);
      return `${line}\n    → hygiene: ${has ? "HAS duplicate_id + is_back_filled — you MUST filter both" : "NO duplicate_id / is_back_filled columns — do NOT reference them, the query will fail"}`;
    })
    .join("\n");
}

// ── SQL guards (deterministic — prompts are not a security boundary) ──

const BANNED =
  /\b(insert|alter|drop|create|truncate|delete|rename|grant|revoke|attach|detach|optimize|system|kill|set|settings)\b/i;

/** Aggregates return summaries; anything larger is a row dump we do not want to
 * ship to the model or the browser. The server cannot enforce this for us —
 * ClickHouse Cloud pins this user to readonly=1, which discards row-limit
 * settings — so the cap lives here. */
const MAX_RESULT_ROWS = 1000;

export function guardSql(raw: string): string {
  let sql = stripFences(raw).trim().replace(/;+\s*$/, "");
  if (sql.includes(";")) throw new Error("exactly one statement allowed (found ';')");
  if (!/^(select|with)\b/i.test(sql)) throw new Error("statement must start with SELECT or WITH");
  if (BANNED.test(sql)) {
    throw new Error(`banned keyword in SQL: ${BANNED.exec(sql)?.[0]}`);
  }
  const limit = /\blimit\s+(\d+)\s*$/i.exec(sql);
  if (!limit) return `${sql}\nLIMIT ${MAX_RESULT_ROWS}`;
  // clamp an oversized explicit LIMIT rather than rejecting an otherwise good query
  if (Number(limit[1]) > MAX_RESULT_ROWS) {
    sql = sql.slice(0, limit.index) + `LIMIT ${MAX_RESULT_ROWS}`;
  }
  return sql;
}

// ── citation checker: every number in prose must exist in results ──

interface TaskResult {
  id: string;
  title: string;
  sql: string;
  rows: Record<string, unknown>[];
  dropped?: string;
  flags: string[];
}

/** Build the pool from exactly the rows the narrator was shown. Using every row
 * let one 1000-row task consume the whole budget and starve later tasks, so a
 * number the narrator could see was reported as uncited and the answer died. */
function numericPool(results: TaskResult[], rowsShown: number): number[] {
  const pool: number[] = [];
  for (const r of results) {
    pool.push(r.rows.length);
    for (const row of r.rows.slice(0, rowsShown)) {
      for (const v of Object.values(row)) {
        const n = typeof v === "number" ? v : Number(v);
        if (Number.isFinite(n)) {
          pool.push(n);
          if (n >= -1 && n <= 1) pool.push(n * 100); // rates quoted as percentages
        }
      }
    }
  }
  return pool;
}

/**
 * A number is citable when it appears in the results, OR when it is the
 * difference/ratio of two values that do — arithmetic code can verify, so the
 * chain back to ClickHouse stays unbroken (PMs need deltas; inventing them is
 * still forbidden).
 */
export function findUncitedNumbers(texts: string[], pool: number[]): string[] {
  const near = (a: number, b: number) =>
    Math.abs(a - b) <= Math.max(0.06, Math.abs(b) * 0.015);
  const base = [...new Set(pool)];
  // Derived pairs are for legitimate deltas, but ~n² of them makes the check
  // permissive on rich results. Only pair the values a narrator actually
  // compares — the first 60 distinct — keeping the guard tight.
  const pairable = base.slice(0, 60);
  const derived: number[] = [];
  for (let i = 0; i < pairable.length; i++) {
    for (let j = 0; j < pairable.length; j++) {
      if (i === j) continue;
      const a = pairable[i]!;
      const b = pairable[j]!;
      derived.push(a - b);
      if (b !== 0) derived.push(a / b);
    }
  }
  const uncited: string[] = [];
  for (const text of texts) {
    for (const m of text.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
      const raw = m[0];
      const n = Number(raw.replaceAll(",", ""));
      if (!Number.isFinite(n)) continue;
      if (Number.isInteger(n) && Math.abs(n) <= 12) continue; // "3 steps", ordinals
      if (Number.isInteger(n) && n >= 2020 && n <= 2030) continue; // years
      if (base.some((v) => near(n, v))) continue;
      if (derived.some((v) => near(n, v))) continue;
      uncited.push(raw);
    }
  }
  return [...new Set(uncited)];
}

// ── value formatting (pure code) ─────────────────────────────────
// The same rate arrives as 0.83 from one query and 83 from another. Rather than
// mutating values (which would break the "every number is in the SQL result"
// chain), classify them so the UI can render correctly.

export type ValueFormat =
  | "fraction"   // 0..1 rate — display as value*100 with a % sign
  | "percent"    // already 0..100 with a % meaning
  | "percentage_points"
  | "count"
  | "ms"
  | "seconds"
  | "currency"
  | "number";

export function inferFormat(name: string, values: number[], sql = ""): ValueFormat {
  const n = name.toLowerCase();
  const max = values.length ? Math.max(...values.map(Math.abs)) : 0;
  // A query that multiplies by 100 emits percentages; 0.383 then means 0.383%,
  // not 38.3%. Values alone cannot distinguish this below 1%.
  const scaledToPercent = /\*\s*100(\.0)?\b/.test(sql);
  if (/_pp$|percentage_point|_delta_pct/.test(n)) return "percentage_points";
  if (/_ms$|latency|duration_ms/.test(n)) return "ms";
  if (/_s$|_sec|seconds|elapsed/.test(n)) return "seconds";
  if (/amount|revenue|value|price|discount|fee/.test(n)) return "currency";
  // suffix match — "share_clicked_applications" is a count, not a share
  if (/(^|_)(rate|ratio|pct|percent)$/.test(n) || /_rate_|success_rate/.test(n)) {
    if (scaledToPercent) return "percent";
    return max <= 1.05 ? "fraction" : "percent";
  }
  if (/^(n|count|users|sessions|rows|payers|uploads|events)/.test(n) || Number.isInteger(max))
    return "count";
  return "number";
}

/** Attach format hints to the chart and to every table column. */
function annotateFormats(insight: Narration, results: TaskResult[]): void {
  const columnsOf = (taskId: string) => {
    const r = results.find((x) => x.id === taskId);
    return r?.rows[0] ? Object.keys(r.rows[0]) : [];
  };
  const sqlOf = (taskId: string) => results.find((x) => x.id === taskId)?.sql ?? "";
  const known = new Set(results.map((r) => r.id));
  // a chart or table pointing at a dropped task cannot be format-inferred, and
  // would cite results the reader cannot open — drop the visual instead
  if (insight.chart && !known.has(insight.chart.sourceTask)) insight.chart = null;
  if (insight.segmentTable && !known.has(insight.segmentTable.sourceTask))
    insight.segmentTable = null;
  if (insight.chart) {
    const cols = columnsOf(insight.chart.sourceTask);
    const valueCol =
      cols.find((c) => /rate|pct|percent|amount|latency|_ms|_pp/i.test(c)) ??
      cols.find((c) => !/^(os|device|platform|segment|label|country|city|month)/i.test(c)) ??
      insight.chart.title;
    insight.chart.valueFormat = inferFormat(
      valueCol,
      insight.chart.series.map((s) => s.value),
      sqlOf(insight.chart.sourceTask),
    );
  }
  if (insight.segmentTable) {
    insight.segmentTable.columnFormats = insight.segmentTable.columns.map((col, i) => {
      const vals = insight.segmentTable!.rows
        .map((r) => Number(r[i]))
        .filter((v) => Number.isFinite(v));
      return vals.length === 0
        ? "text"
        : inferFormat(col, vals, sqlOf(insight.segmentTable!.sourceTask));
    });
  }
}

// ── sanity gate (pure code) ──────────────────────────────────────

function sanityGate(results: TaskResult[]): { kept: TaskResult[]; notes: string[] } {
  const notes: string[] = [];
  const kept: TaskResult[] = [];
  for (const r of results) {
    if (r.rows.length === 0) {
      r.dropped = "empty result set";
      notes.push(`task ${r.id} (${r.title}): dropped — empty result set`);
      continue;
    }
    // The SQL writer declares an impossible task instead of approximating it
    // (see analytics_write_sql). Honour that: drop the task and carry the reason
    // forward, rather than letting the sentinel row be read as data.
    const first = r.rows[0] as Record<string, unknown>;
    if (first && "blocked" in first) {
      const reason = String(first["reason"] ?? "not computable from the available columns");
      r.dropped = `not computable: ${reason}`;
      r.rows = [];
      notes.push(`task ${r.id} (${r.title}): the query could not be written — ${reason}`);
      continue;
    }
    for (const row of r.rows) {
      for (const [col, v] of Object.entries(row)) {
        const n = Number(v);
        if (!Number.isFinite(n)) continue;
        // suffix match, not substring: "share_clicked_applications" is a count,
        // and matching "share" inside it flagged 1,601 as a rate above 100%
        if (/(^|_)(rate|ratio|pct|percent)$/i.test(col) && n > 1.05) {
          r.flags.push(`${col}=${n} looks like a rate above 100%`);
        }
      }
    }
    const sampleCols = r.rows.flatMap((row) =>
      Object.entries(row).filter(([c]) => /^(n|count|total|users|sessions|payers|uploads)/i.test(c)),
    );
    if (sampleCols.length > 0 && sampleCols.every(([, v]) => Number(v) < 50)) {
      r.flags.push("all sample sizes below 50 — low confidence");
    }
    r.flags = [...new Set(r.flags)];
    for (const f of r.flags) notes.push(`task ${r.id} (${r.title}): flagged — ${f}`);
    kept.push(r);
  }
  return { kept, notes };
}

// ── main ─────────────────────────────────────────────────────────

/** Rows per task shown to the narrator — and therefore the rows it may cite. */
const NARRATION_ROWS = 24;
const MAX_SQL_ATTEMPTS = 3;
const MAX_NARRATE_ATTEMPTS = 3;

export interface AnalyticsInput {
  question: string;
  /** Force a fresh run, bypassing the answer cache. */
  noCache?: boolean;
  /** Recent conversation turns for follow-up questions (oldest first). */
  history?: Array<{ role: "user" | "agent"; text: string }>;
}

/** What the answer judge needs and the Insight does not carry: the rows behind
 *  each figure. Judging relevance from the SQL text alone is guesswork. */
export interface AnswerEvidence {
  task: string;
  title: string;
  sql: string;
  rowCount: number;
  /** Bounded sample of exactly the rows the narrator was shown. */
  rows: Record<string, unknown>[];
  dropped?: string;
  flags: string[];
}

export interface RunAnalyticsOptions {
  trace: Ctx;
  llm?: (parent: Ctx, name: string, prompt: string) => Promise<string>;
  /**
   * Called with the task results once, on a freshly computed answer. Deliberately
   * a callback rather than a return value: it leaves the Insight contract (and
   * therefore insight_cache) untouched, and it simply does not fire on a cache
   * hit — which is exactly when there is nothing new to judge.
   */
  onEvidence?: (evidence: AnswerEvidence[]) => void;
}

export async function runAnalytics(
  input: AnalyticsInput,
  opts: RunAnalyticsOptions,
): Promise<Insight> {
  const llm =
    opts.llm ??
    ((parent: Ctx, name: string, prompt: string) =>
      complete(parent, name, prompt, { maxTokens: 8000 }));

  // Self-attributing: tagging here rather than at the call site means every
  // query this agent runs is labelled "analytics" in system.query_log (and so on
  // the Observe screen) no matter which route ends up invoking it.
  return withQueryContext({ agent: "analytics" }, () =>
   step(opts.trace, "analytics", { question: input.question }, async (span) => {
    // ── context (read-only) ──
    const { bundle, sqlRules, schemas, contextVersion, contextKey } = await step(
      span,
      "context_load",
      {},
      async () => {
        const [b, sqlRules, recon, schemas] = await Promise.all([
          // metrics/conventions/known-issues in full (they define correctness);
          // table docs brief because `schemas` already gives exact columns.
          getContext({
            include: ["*"],
            brief: ["table", "spec", "overview", "entity"],
            require: ["convention:data_hygiene", "metric"],
          }),
          // SQL generation needs the RULES only — not metrics, known issues or
          // spec summaries. Those belong to planning and narration.
          getContext({ core: ["convention"], require: ["convention:data_hygiene"] }),
          reconcileWithLive(),
          tableSchemas(),
        ]);
        // A digest over every (entity, version) pair — the entity count and the
        // global max both miss a revision that lands below the current max, which
        // would serve a stale answer after a context write.
        const versionDigest = createHash("sha1")
          .update(b.entries.map((e) => `${e.entity}@${e.version}`).sort().join("|"))
          .digest("hex")
          .slice(0, 10);
        const maxV = Math.max(...b.entries.map((e) => e.version));
        return {
          bundle: b,
          sqlRules,
          liveTables: recon.liveTables,
          schemas,
          contextVersion: `${b.entries.length} entities · max v${maxV}`,
          contextKey: versionDigest,
        };
      },
    );

    // Cache hit → milliseconds. Skipped for follow-ups, whose meaning depends
    // on conversation state rather than the question text alone.
    const key = cacheKey(input.question, contextKey);
    if (!input.history?.length && !input.noCache) {
      const cached = await step(span, "cache_lookup", { key }, () => readCache(key));
      if (cached) {
        scoreRun(span, "cache_hit", 1, "served from insight_cache");
        return { ...cached, cached: true };
      }
    }

    const historyText =
      input.history && input.history.length > 0
        ? input.history
            .slice(-6)
            .map((h) => `${h.role}: ${h.text}`)
            .join("\n")
        : "(none)";

    // ── plan ──
    const plan: Plan = await step(span, "plan", {}, async (planSpan) => {
      const prompt = await loadPrompt("analytics_plan_tasks", {
        knowledge: bundle.markdown,
        // planning needs column NAMES to choose tables/dimensions; exact types
        // only matter when writing SQL, so strip them here (~half the tokens)
        schemas: [...schemas.values()]
          .map((line) => line.replace(/ (String|UInt\d+|Int\d+|Float\d+|DateTime64?\(\d\)|LowCardinality\(String\)|Nullable\([^)]+\)|UUID)(,|$)/g, "$2"))
          .join("\n"),
        history: historyText,
        question: input.question,
      });
      const text = await llm(planSpan, "plan", prompt);
      return PlanSchema.parse(JSON.parse(stripFences(text)));
    });
    if (plan.tasks.length === 0) {
      // unanswerable — return an honest empty insight, still traced
      return {
        headline: `This can't be answered from the current tables: ${plan.approach}`,
        findings: [{ tag: "caveat", text: plan.approach }],
        chart: null,
        segmentTable: null,
        confidence: { value: "low", note: "no queryable data for this question" },
        contextVersion,
        sql: [],
      };
    }

    // ── SQL per task, guarded + self-healing ──
    // Tasks are independent → generate + execute them CONCURRENTLY. Wall clock
    // becomes the slowest single task instead of their sum.
    let sqlAttemptsTotal = 0;
    const results: TaskResult[] = await Promise.all(
      plan.tasks.map((task) =>
        step(span, `task_${task.id}`, { title: task.title }, async (taskSpan) => {
          let feedback = "";
          let lastTransient = "";
          for (let attempt = 1; attempt <= MAX_SQL_ATTEMPTS; attempt++) {
            sqlAttemptsTotal++;
            try {
              return await step(
                taskSpan,
                `sql_attempt_${attempt}`,
                { task: task.title, feedback },
                async (sqlSpan) => {
                  const prompt = await loadPrompt("analytics_write_sql", {
                    context: sqlRules.markdown,
                    schemas: schemaSubset(schemas, task.tables),
                    task: JSON.stringify(task),
                    feedback: feedback
                      ? `\n# Feedback on your previous attempt — fix this\n${feedback}\n`
                      : "",
                  });
                  const sql = guardSql(await llm(sqlSpan, `sql_${task.id}`, prompt));
                  const rows = await queryReadonly(sql);
                  recordQuery(sqlSpan, `result_${task.id}`, sql, rows);
                  return { id: task.id, title: task.title, sql, rows, flags: [] } as TaskResult;
                },
              );
            } catch (error) {
              if (isTransientDbError(error)) {
                // infrastructure, not the SQL: back off and regenerate without
                // blaming the model, but say so if we exhaust the attempts
                feedback = "";
                lastTransient = error instanceof Error ? error.message : String(error);
                await new Promise((r) => setTimeout(r, 1000 * attempt));
                continue;
              }
              feedback = `Your SQL failed: ${error instanceof Error ? error.message : String(error)}`;
            }
          }
          return {
            id: task.id,
            title: task.title,
            sql: "",
            rows: [],
            flags: [],
            dropped: `gave up after ${MAX_SQL_ATTEMPTS} attempts: ${feedback || lastTransient || "unknown error"}`,
          } as TaskResult;
        }),
      ),
    );

    // ── sanity gate ──
    const { kept, notes } = await step(span, "sanity_gate", {}, async () =>
      sanityGate(results.filter((r) => !r.dropped)),
    );
    const failedTasks = results.filter((r) => r.dropped);
    const sanityNotes = [...notes, ...failedTasks.map((r) => `task ${r.id}: ${r.dropped}`)];

    // ── knowledge lookup for the "why" ──
    const digest = kept
      .map((r) => `${r.title}: ${JSON.stringify(r.rows.slice(0, 3))}`)
      .join("\n")
      .slice(0, 1500);
    const lookup = await lookupContext(span, `${input.question}\n${digest}`, opts.llm);

    // ── narrate → citation check → (maybe) quality revision ──
    const resultsText = kept
      .map(
        (r) =>
          `### ${r.id} — ${r.title} (${r.rows.length} rows${r.flags.length ? `; flags: ${r.flags.join("; ")}` : ""})\nSQL: ${r.sql}\nrows: ${JSON.stringify(r.rows.slice(0, NARRATION_ROWS))}${r.rows.length > NARRATION_ROWS ? `\n(+${r.rows.length - NARRATION_ROWS} more rows not shown — do not infer beyond what is listed)` : ""}`,
      )
      .join("\n\n");
    // What the queries ACTUALLY did, read off the executed SQL. The citation
    // checker guards numbers; without this the narrator would assert methodology
    // (e.g. "hygiene filters applied") that may not be true of the query that ran.
    const methodNotes = kept
      .map((r) => {
        const bits: string[] = [];
        // Only state what can be checked from the SQL itself. Whether the columns
        // exist is a separate fact we are not verifying here, so do not claim it.
        bits.push(
          /\bduplicate_id\b/i.test(r.sql)
            ? "hygiene filters applied (duplicate_id / is_back_filled)"
            : "no hygiene filters were applied in this query",
        );
        if (/if\s*\(\s*os\s+IS\s+NULL|multiIf\s*\(\s*\(?\s*os\s+IS\s+NULL/i.test(r.sql))
          bits.push("empty/NULL os bucketed as 'unknown'");
        if (/group by[\s\S]*currency/i.test(r.sql)) bits.push("grouped by currency");
        return `${r.id}: ${bits.join("; ")}`;
      })
      .join("\n");

    const pool = [
      ...numericPool(kept, NARRATION_ROWS),
      // numbers the agent was shown in the gate notes are citable too
      ...sanityNotes
        .join(" ")
        .match(/-?\d[\d,]*(?:\.\d+)?/g)
        ?.map((n) => Number(n.replaceAll(",", "")))
        .filter((n) => Number.isFinite(n)) ?? [],
    ];

    let narration: Narration | null = null;
    let citationFailures = 0;
    let feedback = "";
    for (let attempt = 1; attempt <= MAX_NARRATE_ATTEMPTS; attempt++) {
      try {
        narration = await step(
          span,
          `narrate_attempt_${attempt}`,
          { feedback },
          async (nSpan) => {
            const prompt = await loadPrompt("analytics_narrate_insight", {
              question: input.question,
              plan: plan.approach,
              results: resultsText || "(all tasks failed — say so honestly)",
              sanity: sanityNotes.join("\n") || "(clean)",
              method: methodNotes || "(no queries succeeded)",
              lookup: lookup.markdown || "(nothing relevant retrieved)",
              context_version: contextVersion,
              history: input.history?.length ? `\n# Conversation so far\n${historyText}\n` : "",
              feedback: feedback
                ? `\n# Feedback on your previous attempt — fix this\n${feedback}\n`
                : "",
            });
            const text = await llm(nSpan, "narrate", prompt);
            const parsed = NarrationSchema.parse(JSON.parse(stripFences(text)));

            const texts = [
              parsed.headline,
              ...parsed.findings.map((f) => f.text),
              ...(parsed.chart?.series.map((s) => String(s.value)) ?? []),
              ...(parsed.segmentTable?.rows.flat().map(String) ?? []),
            ];
            const uncited = findUncitedNumbers(texts, pool);
            if (uncited.length > 0) {
              citationFailures++;
              throw new Error(
                `these numbers are not in the SQL results and are not a difference/ratio of two numbers that are: ${uncited.join(", ")}. ` +
                  `Rewrite using only values present in the results (or a difference/ratio of two such values), or describe the comparison in words instead of a figure.`,
              );
            }
            return parsed;
          },
        );
        break;
      } catch (error) {
        feedback = error instanceof Error ? error.message : String(error);
        if (attempt === MAX_NARRATE_ATTEMPTS)
          throw new Error(`narration failed citation/schema checks ${attempt} times: ${feedback}`);
      }
    }
    if (!narration) throw new Error("unreachable: narration missing");

    // code-enforced confidence cap — the LLM can't self-award "high"
    if ((sanityNotes.length > 0 || citationFailures > 0) && narration.confidence.value === "high") {
      narration.confidence = {
        value: "medium",
        note: `capped by gate: ${sanityNotes[0] ?? "citation retries occurred"}`,
      };
    }

    // ── quality gate ──
    // Skip the call when the deterministic checks all passed and the narration
    // already cites numbers, names a segment and is honest about confidence —
    // there is nothing for a reviewer to catch, and this saves a full LLM round.
    const selfEvident =
      sanityNotes.length === 0 &&
      citationFailures === 0 &&
      narration.findings.some((f) => f.tag === "segment") &&
      /\d/.test(narration.headline);
    const quality = selfEvident
      ? {
          actionable: true, cites_numbers: true, names_segment: true,
          links_known_issue: true, honest_confidence: true,
          verdict: "pass" as const, revision_note: "",
        }
      : await step(span, "quality_gate", {}, async (qSpan) => {
      const prompt = await loadPrompt("analytics_review_quality", {
        question: input.question,
        insight: JSON.stringify(narration),
        results: resultsText.slice(0, 4000),
      });
      const text = await llm(qSpan, "quality", prompt);
      return QualitySchema.parse(JSON.parse(stripFences(text)));
    });

    if (quality.verdict === "revise" && quality.revision_note) {
      const preRevision = narration;
      narration = await step(span, "narrate_revision", { note: quality.revision_note }, async (rSpan) => {
        const prompt = await loadPrompt("analytics_narrate_insight", {
          question: input.question,
          plan: plan.approach,
          results: resultsText || "(all tasks failed)",
          sanity: sanityNotes.join("\n") || "(clean)",
          method: methodNotes || "(no queries succeeded)",
          lookup: lookup.markdown || "(nothing relevant retrieved)",
          context_version: contextVersion,
          history: "",
          feedback: `\n# Quality reviewer's instruction — apply it\n${quality.revision_note}\n`,
        });
        const text = await llm(rSpan, "narrate", prompt);
        const parsed = NarrationSchema.parse(JSON.parse(stripFences(text)));
        const uncited = findUncitedNumbers(
          [parsed.headline, ...parsed.findings.map((f) => f.text)],
          pool,
        );
        if (uncited.length > 0) {
          // keep the answer that already passed every check rather than failing
          // the request over a cosmetic revision
          emitRunEvent({
            type: "log",
            name: "revision_discarded",
            payload: { reason: `introduced uncited numbers: ${uncited.join(", ")}` },
          });
          return preRevision;
        }
        return parsed;
      }).catch(() => preRevision);
    }

    annotateFormats(narration, kept);

    const insight: Insight = {
      ...narration,
      contextVersion,
      sql: results.map((r) => ({
        task: r.id,
        title: r.title,
        query: r.sql,
        rowCount: r.rows.length,
      })),
    };
    if (!input.history?.length) {
      await insert("insight_cache", [
        {
          cache_key: key,
          question: input.question,
          context_key: contextVersion,
          insight_json: JSON.stringify(insight),
          created_at: new Date().toISOString().replace("T", " ").replace("Z", ""),
        },
      ]).catch(() => {});
    }

    scoreRun(span, "analytics_tasks", plan.tasks.length);
    scoreRun(span, "sql_attempts_total", sqlAttemptsTotal);
    scoreRun(span, "sanity_flags", sanityNotes.length);
    scoreRun(span, "citation_failures", citationFailures);
    scoreRun(span, "quality_gate_passed", quality.verdict === "pass" ? 1 : 0);

    opts.onEvidence?.(
      results.map((r) => ({
        task: r.id,
        title: r.title,
        sql: r.sql,
        rowCount: r.rows.length,
        rows: r.rows.slice(0, 20),
        ...(r.dropped ? { dropped: r.dropped } : {}),
        flags: r.flags,
      })),
    );

    return {
      ...narration,
      contextVersion,
      sql: results.map((r) => ({
        task: r.id,
        title: r.title,
        query: r.sql,
        rowCount: r.rows.length,
      })),
    };
   }),
  );
}
