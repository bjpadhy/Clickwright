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
import { z } from "zod";
import { queryReadonly } from "../core/db.js";
import { withQueryContext } from "../core/query-context.js";
import { step, scoreRun, recordQuery, type Ctx } from "../core/tracing.js";
import { complete, loadPrompt, stripFences } from "../core/llm.js";
import { getContext, lookupContext, reconcileWithLive } from "./context.js";

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
    const { bundle, liveTables, contextVersion } = await step(
      span,
      "context_load",
      {},
      async () => {
        const b = await getContext({ include: ["*"] });
        const recon = await reconcileWithLive();
        const maxV = Math.max(...b.entries.map((e) => e.version));
        return {
          bundle: b,
          liveTables: recon.liveTables,
          contextVersion: `${b.entries.length} entities · max v${maxV}`,
        };
      },
    );

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
    let sqlAttemptsTotal = 0;
    const results: TaskResult[] = [];
    for (const task of plan.tasks) {
      let feedback = "";
      let done = false;
      for (let attempt = 1; attempt <= MAX_SQL_ATTEMPTS && !done; attempt++) {
        sqlAttemptsTotal++;
        try {
          await step(
            span,
            `task_${task.id}_sql_attempt_${attempt}`,
            { task: task.title, feedback },
            async (sqlSpan) => {
              const prompt = await loadPrompt("analytics_sql", {
                context: bundle.markdown,
                live_tables: liveTables.join(", "),
                task: JSON.stringify(task),
                feedback: feedback
                  ? `\n# Feedback on your previous attempt — fix this\n${feedback}\n`
                  : "",
              });
              const sql = guardSql(await llm(sqlSpan, `sql_${task.id}`, prompt));
              const rows = await queryReadonly(sql);
              recordQuery(sqlSpan, `result_${task.id}`, sql, rows);
              results.push({ id: task.id, title: task.title, sql, rows, flags: [] });
              done = true;
              return { rows: rows.length };
            },
          );
        } catch (error) {
          feedback = `Your SQL failed: ${error instanceof Error ? error.message : String(error)}`;
          if (attempt === MAX_SQL_ATTEMPTS) {
            results.push({
              id: task.id,
              title: task.title,
              sql: "",
              rows: [],
              flags: [],
              dropped: `gave up after ${MAX_SQL_ATTEMPTS} attempts: ${feedback}`,
            });
          }
        }
      }
    }

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
    const pool = numericPool(kept);

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
    const quality = await step(span, "quality_gate", {}, async (qSpan) => {
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
