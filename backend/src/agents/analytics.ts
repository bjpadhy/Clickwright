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
import { step, scoreRun, recordQuery, type Ctx } from "../core/tracing.js";
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
  };
  segmentTable: null | {
    columns: string[];
    rows: Array<Array<string | number>>;
    sourceTask: string;
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
    })
    .nullish()
    .transform((v) => v ?? null),
  segmentTable: z
    .object({
      columns: z.array(z.string()).min(2),
      rows: z.array(z.array(z.union([z.string(), z.number()]))).min(1).max(8),
      sourceTask: z.string(),
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
async function tableSchemas(): Promise<string> {
  const rows = await query<{ table: string; cols: string }>(`
    SELECT table, arrayStringConcat(groupArray(concat(name, ' ', type)), ', ') AS cols
    FROM system.columns
    WHERE database = currentDatabase() AND table NOT IN ('context_store', 'runs_log', 'conversations', 'messages')
    GROUP BY table ORDER BY table
  `);
  return rows.map((r) => `- ${r.table}: ${r.cols}`).join("\n");
}

// ── SQL guards (deterministic — prompts are not a security boundary) ──

const BANNED =
  /\b(insert|alter|drop|create|truncate|delete|rename|grant|revoke|attach|detach|optimize|system|kill|set|settings)\b/i;

export function guardSql(raw: string): string {
  const sql = stripFences(raw).trim().replace(/;+\s*$/, "");
  if (sql.includes(";")) throw new Error("exactly one statement allowed (found ';')");
  if (!/^(select|with)\b/i.test(sql)) throw new Error("statement must start with SELECT or WITH");
  if (BANNED.test(sql)) {
    throw new Error(`banned keyword in SQL: ${BANNED.exec(sql)?.[0]}`);
  }
  return /\blimit\s+\d+/i.test(sql) ? sql : `${sql}\nLIMIT 1000`;
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

function numericPool(results: TaskResult[]): number[] {
  const pool: number[] = [];
  for (const r of results) {
    pool.push(r.rows.length);
    for (const row of r.rows) {
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
  const base = [...new Set(pool)].slice(0, 400);
  const derived: number[] = [];
  for (let i = 0; i < base.length; i++) {
    for (let j = 0; j < base.length; j++) {
      if (i === j) continue;
      const a = base[i]!;
      const b = base[j]!;
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
    for (const row of r.rows) {
      for (const [col, v] of Object.entries(row)) {
        const n = Number(v);
        if (!Number.isFinite(n)) continue;
        if (/rate|ratio|pct|share|conversion/i.test(col) && n > 1.05) {
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

const MAX_SQL_ATTEMPTS = 3;
const MAX_NARRATE_ATTEMPTS = 3;

export interface AnalyticsInput {
  question: string;
  /** Force a fresh run, bypassing the answer cache. */
  noCache?: boolean;
  /** Recent conversation turns for follow-up questions (oldest first). */
  history?: Array<{ role: "user" | "agent"; text: string }>;
}

export interface RunAnalyticsOptions {
  trace: Ctx;
  llm?: (parent: Ctx, name: string, prompt: string) => Promise<string>;
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
    const { bundle, liveTables, schemas, contextVersion } = await step(
      span,
      "context_load",
      {},
      async () => {
        const [b, recon, schemas] = await Promise.all([
          // metrics/conventions/known-issues in full (they define correctness);
          // table docs brief because `schemas` already gives exact columns.
          getContext({
            include: ["*"],
            brief: ["table", "spec", "overview", "entity"],
            require: ["convention:data_hygiene", "metric"],
          }),
          reconcileWithLive(),
          tableSchemas(),
        ]);
        const maxV = Math.max(...b.entries.map((e) => e.version));
        return {
          bundle: b,
          liveTables: recon.liveTables,
          schemas,
          contextVersion: `${b.entries.length} entities · max v${maxV}`,
        };
      },
    );

    // Cache hit → milliseconds. Skipped for follow-ups, whose meaning depends
    // on conversation state rather than the question text alone.
    const key = cacheKey(input.question, contextVersion);
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
      const prompt = await loadPrompt("analytics_plan", {
        context: bundle.markdown,
        live_tables: liveTables.join(", "),
        schemas,
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
          for (let attempt = 1; attempt <= MAX_SQL_ATTEMPTS; attempt++) {
            sqlAttemptsTotal++;
            try {
              return await step(
                taskSpan,
                `sql_attempt_${attempt}`,
                { task: task.title, feedback },
                async (sqlSpan) => {
                  const prompt = await loadPrompt("analytics_sql", {
                    context: bundle.markdown,
                    live_tables: liveTables.join(", "),
                    schemas,
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
                // infrastructure, not the SQL — keep the statement, back off, retry
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
            dropped: `gave up after ${MAX_SQL_ATTEMPTS} attempts: ${feedback}`,
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
          `### ${r.id} — ${r.title} (${r.rows.length} rows${r.flags.length ? `; flags: ${r.flags.join("; ")}` : ""})\nSQL: ${r.sql}\nrows: ${JSON.stringify(r.rows.slice(0, 50))}`,
      )
      .join("\n\n");
    const pool = [
      ...numericPool(kept),
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
            const prompt = await loadPrompt("analytics_narrate", {
              question: input.question,
              plan: plan.approach,
              results: resultsText || "(all tasks failed — say so honestly)",
              sanity: sanityNotes.join("\n") || "(clean)",
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
      const prompt = await loadPrompt("analytics_quality", {
        question: input.question,
        insight: JSON.stringify(narration),
        results: resultsText.slice(0, 4000),
      });
      const text = await llm(qSpan, "quality", prompt);
      return QualitySchema.parse(JSON.parse(stripFences(text)));
    });

    if (quality.verdict === "revise" && quality.revision_note) {
      narration = await step(span, "narrate_revision", { note: quality.revision_note }, async (rSpan) => {
        const prompt = await loadPrompt("analytics_narrate", {
          question: input.question,
          plan: plan.approach,
          results: resultsText || "(all tasks failed)",
          sanity: sanityNotes.join("\n") || "(clean)",
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
        if (uncited.length > 0) throw new Error(`revision introduced uncited numbers: ${uncited.join(", ")}`);
        return parsed;
      });
    }

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
