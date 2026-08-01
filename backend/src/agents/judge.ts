/**
 * Answer Judge — an independent, out-of-band grader for Analytics Agent answers.
 *
 * Distinct from analytics.ts's inline `quality_gate`, which is a REWRITER: it
 * runs in the critical path, judges the prose, and can force a revision. This is
 * an AUDITOR: it runs after the answer is sent, never changes it, and looks at
 * the thing the gate never does — the SQL.
 *
 * Two axes, as asked for:
 *   relevance — did the data returned actually answer the question?
 *   sql       — was the query correct?
 *
 * The hard part is that a model asked "is this good?" says yes. Three defences:
 *   1. Code checks what code can check. Every trap in base_context.md is a
 *      regex over the SQL, so hygiene filters, currency grouping and denominator
 *      choice become FACTS in the findings list whatever the model says.
 *   2. The judge sees ground truth (live schema + conventions), not the agent's
 *      reasoning — and deliberately NOT the agent's own confidence note or gate
 *      verdict. Anchoring on the generator's self-assessment is how a judge
 *      becomes a rubber stamp.
 *   3. Every verdict must cite specific evidence, enforced by the schema.
 */
import { z } from "zod";
import { command, insert, query } from "../core/db.js";
import { env } from "../core/env.js";
import { complete, extractJson, loadPrompt, type Effort } from "../core/llm.js";
import { withQueryContext } from "../core/query-context.js";
import { endRun, flushTraces, startRun, step, scoreRun, traceUrl } from "../core/tracing.js";
import { getContext } from "./context.js";
import type { AnswerEvidence, Insight } from "./analytics.js";

// ── types ────────────────────────────────────────────────────────

export type Verdict = "pass" | "warn" | "fail";

export interface Finding {
  kind: "hygiene" | "denominator" | "currency" | "join" | "citation" | "coverage";
  severity: "info" | "warn" | "fail";
  text: string;
  task: string | null;
}

export interface Judgement {
  convId: string;
  seq: number;
  question: string;
  askedAt: string;
  judgedAt: string;
  overall: Verdict;
  relevance: { verdict: Verdict; score: number; reason: string };
  sql: { verdict: Verdict; score: number; reason: string };
  findings: Finding[];
  queries: Array<{ task: string; title: string; sql: string; rowCount: number }>;
  model: string;
  answerTraceUrl: string | null;
  judgeTraceUrl: string | null;
}

// ── deterministic checks (no LLM) ────────────────────────────────
// base_context.md documents the exact traps this dataset was built around.
// Each is decidable from the SQL text, so it is reported as fact rather than
// left to a model's judgement.

/** Strip string literals and comments so keywords inside them don't match. */
export function sqlSkeleton(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .toLowerCase();
}

/** Tables the query reads, ignoring aliases. */
export function tablesUsed(sql: string): string[] {
  const body = sqlSkeleton(sql);
  const found = new Set<string>();
  for (const m of body.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)/g)) {
    if (m[1] && !["select", "unnest"].includes(m[1])) found.add(m[1]);
  }
  return [...found];
}

/**
 * Which documented conventions a single query honours or breaks.
 *
 * The hygiene checks only apply to tables that actually carry the flags — the
 * base event tables. Demanding `duplicate_id IS NULL` from a query over
 * context_store would be a false positive, and a findings list full of those
 * teaches people to ignore it.
 */
export function checkConventions(
  ev: AnswerEvidence,
  flaggedTables: ReadonlySet<string>,
): Finding[] {
  const body = sqlSkeleton(ev.sql);
  const findings: Finding[] = [];
  const touches = tablesUsed(ev.sql).filter((t) => flaggedTables.has(t));

  if (touches.length > 0) {
    if (!/duplicate_id\s+is\s+null/.test(body)) {
      findings.push({
        kind: "hygiene",
        severity: "fail",
        task: ev.task,
        text: `does not filter duplicate_id IS NULL on ${touches.join(", ")} — convention:data_hygiene puts duplicates at ~3% of rows, so every count here is inflated`,
      });
    }
    if (!/is_back_filled/.test(body)) {
      findings.push({
        kind: "hygiene",
        severity: "fail",
        task: ev.task,
        text: `does not filter is_back_filled on ${touches.join(", ")} — ~2% of rows are backfilled (measured impact on purchase_completed: −4.8%)`,
      });
    }
  }

  // Revenue is `value` in `currency`; 9 currencies observed, avg INR ~5,035 vs
  // avg USD ~44. Summing across them is meaningless.
  if (/\b(sum|avg)\s*\(\s*value\s*\)/.test(body) && !/group\s+by[^;]*currency/.test(body)) {
    findings.push({
      kind: "currency",
      severity: "fail",
      task: ev.task,
      text: "aggregates `value` without GROUP BY currency — table:purchase_completed records 9 currencies, so the total mixes units",
    });
  }

  // os is NULL on ~18% of android rows in base tables and '' in ndjson-loaded
  // spec tables; an unbucketed cut silently drops or splits them.
  if (/\bos\b/.test(body) && !/os\s+is\s+null|os\s*=\s*''|coalesce\s*\(\s*os|unknown/.test(body)) {
    findings.push({
      kind: "hygiene",
      severity: "warn",
      task: ev.task,
      text: "cuts by `os` without bucketing NULL/empty as 'unknown' — ~18% of android rows have no os",
    });
  }

  // destination_card_clicked has an empty application_id: no application exists
  // at top of funnel, so joining on it drops every row.
  if (/destination_card_clicked/.test(body) && /join[^;]*\bapplication_id\b/.test(body)) {
    findings.push({
      kind: "join",
      severity: "fail",
      task: ev.task,
      text: "joins destination_card_clicked on application_id — that column is empty at top of funnel, so the join returns nothing",
    });
  }

  if (ev.rowCount === 0) {
    findings.push({
      kind: "coverage",
      severity: "warn",
      task: ev.task,
      text: "returned no rows, so nothing in the answer can rest on this query",
    });
  }
  if (ev.dropped) {
    findings.push({
      kind: "coverage",
      severity: "info",
      task: ev.task,
      text: `dropped by the sanity gate: ${ev.dropped}`,
    });
  }
  for (const flag of ev.flags) {
    findings.push({ kind: "coverage", severity: "warn", task: ev.task, text: flag });
  }
  return findings;
}

/** The conversion denominator is a documented, easily-missed definition. */
export function checkDenominator(question: string, evidence: AnswerEvidence[]): Finding[] {
  if (!/convers|drop[- ]?off|funnel|rate/i.test(question)) return [];
  const all = evidence.map((e) => sqlSkeleton(e.sql)).join(" ");
  if (!all) return [];
  const perUser = /count\s*\(\s*distinct\s+user_id/.test(all) || /uniq\s*\(\s*user_id/.test(all);
  const perSession = /app_session_id/.test(all);
  if (perUser && !perSession) {
    return [
      {
        kind: "denominator",
        severity: "warn",
        task: null,
        text: "conversion is computed per user, but metric:conversion_rate defines it per SESSION (app_session_id) — confirm which the question meant",
      },
    ];
  }
  return [];
}

export function overallFrom(relevance: Verdict, sql: Verdict): Verdict {
  if (relevance === "fail" || sql === "fail") return "fail";
  if (relevance === "warn" || sql === "warn") return "warn";
  return "pass";
}

// ── LLM judge ────────────────────────────────────────────────────

const JudgeSchema = z.object({
  relevance: z.object({
    verdict: z.enum(["pass", "warn", "fail"]),
    score: z.number().min(0).max(1),
    // A verdict with no citation is rejected by the schema and regenerated.
    reason: z.string().min(30),
  }),
  sql: z.object({
    verdict: z.enum(["pass", "warn", "fail"]),
    score: z.number().min(0).max(1),
    reason: z.string().min(30),
  }),
});

export async function initJudgeTable(): Promise<void> {
  await command(`
    CREATE TABLE IF NOT EXISTS chat_judgements (
      conv_id           String,
      seq               UInt32,
      question          String,
      asked_at          DateTime64(3),
      judged_at         DateTime64(3),
      overall           LowCardinality(String),
      relevance_verdict LowCardinality(String),
      relevance_score   Float32,
      relevance_reason  String,
      sql_verdict       LowCardinality(String),
      sql_score         Float32,
      sql_reason        String,
      findings_json     String,
      queries_json      String,
      model             String,
      answer_trace_url  String,
      judge_trace_url   String
    ) ENGINE = ReplacingMergeTree(judged_at) ORDER BY (conv_id, seq)
    COMMENT 'Independent post-hoc evaluation of each Analytics Agent answer'
  `);
}

/** Tables that carry duplicate_id / is_back_filled — i.e. the event tables. */
async function flaggedTables(): Promise<Set<string>> {
  try {
    const rows = await query<{ table: string }>(`
      SELECT DISTINCT table FROM system.columns
      WHERE database = currentDatabase() AND name IN ('duplicate_id', 'is_back_filled')
    `);
    return new Set(rows.map((r) => r.table));
  } catch {
    return new Set();
  }
}

function renderEvidence(evidence: AnswerEvidence[]): string {
  return evidence
    .map((e) => {
      const sample = e.rows.length
        ? JSON.stringify(e.rows.slice(0, 8), null, 1).slice(0, 1800)
        : "(no rows)";
      return `### task ${e.task} — ${e.title}\nrows returned: ${e.rowCount}\n\`\`\`sql\n${e.sql}\n\`\`\`\nsample rows:\n${sample}`;
    })
    .join("\n\n");
}

export interface JudgeInput {
  convId: string;
  seq: number;
  question: string;
  askedAt: string;
  insight: Insight;
  evidence: AnswerEvidence[];
  answerTraceUrl: string | null;
}

/**
 * Grade one answer. Never throws — a judge failure must not affect anything the
 * user sees, and there is nothing to retry into.
 */
export async function judgeAnswer(input: JudgeInput): Promise<Judgement | null> {
  const model = env.llm.judgeModel;
  const trace = startRun(
    `judge:${input.question.slice(0, 60)}`,
    { question: input.question, convId: input.convId, seq: input.seq },
    { sessionId: input.convId },
  );
  const judgeUrl = traceUrl(trace);

  try {
    return await withQueryContext({ agent: "analytics" }, async () => {
      await initJudgeTable();

      // 1. Facts, decided by code.
      const findings = await step(trace, "judge_evidence", { tasks: input.evidence.length }, async () => {
        const flagged = await flaggedTables();
        const out: Finding[] = [];
        for (const ev of input.evidence) out.push(...checkConventions(ev, flagged));
        out.push(...checkDenominator(input.question, input.evidence));
        return out;
      });

      // 2. Ground truth, given directly — not the agent's reasoning.
      const [schema, conventions] = await Promise.all([
        query<{ table: string; cols: string }>(`
          SELECT table, arrayStringConcat(groupArray(concat(name, ' ', type)), ', ') AS cols
          FROM system.columns WHERE database = currentDatabase()
            AND table NOT IN ('context_store','runs_log','conversations','messages',
                              'dashboards','insight_cache','optimization_suggestions','chat_judgements')
          GROUP BY table ORDER BY table
        `).then((rows) => rows.map((r) => `- ${r.table}: ${r.cols}`).join("\n")),
        getContext({ core: ["convention"], include: ["metric", "known_issue"] }).then((b) => b.markdown),
      ]);

      const graded = await step(trace, "judge_grade", { model }, async (span) => {
        const prompt = await loadPrompt("judge_answer", {
          question: input.question,
          headline: input.insight.headline,
          findings_text: input.insight.findings.map((f) => `- [${f.tag}] ${f.text}`).join("\n"),
          evidence: renderEvidence(input.evidence),
          schema,
          conventions,
          checks:
            findings.length > 0
              ? findings.map((f) => `- [${f.severity}] ${f.kind}: ${f.text}`).join("\n")
              : "(no automated check failed)",
        });
        const text = await complete(span, "judge", prompt, {
          model,
          effort: env.llm.judgeEffort as Effort,
          // Thinking is on by default on opus-5 and shares this budget.
          maxTokens: 16000,
        });
        return JudgeSchema.parse(extractJson(text));
      });

      // A deterministic failure outranks the model's opinion: code proved it.
      const hardFail = findings.some((f) => f.severity === "fail");
      const sqlVerdict: Verdict = hardFail ? "fail" : graded.sql.verdict;
      const overall = overallFrom(graded.relevance.verdict, sqlVerdict);

      const judgement: Judgement = {
        convId: input.convId,
        seq: input.seq,
        question: input.question,
        askedAt: input.askedAt,
        judgedAt: new Date().toISOString(),
        overall,
        relevance: graded.relevance,
        sql: { ...graded.sql, verdict: sqlVerdict },
        findings,
        queries: input.evidence.map((e) => ({
          task: e.task,
          title: e.title,
          sql: e.sql,
          rowCount: e.rowCount,
        })),
        model,
        answerTraceUrl: input.answerTraceUrl,
        judgeTraceUrl: judgeUrl,
      };

      await persist(judgement);
      scoreRun(trace, "judge_relevance", graded.relevance.score);
      scoreRun(trace, "judge_sql_correctness", graded.sql.score,
        hardFail ? "forced to fail by a deterministic convention check" : undefined);
      endRun(trace, { overall, relevance: graded.relevance.verdict, sql: sqlVerdict });
      return judgement;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    endRun(trace, { status: "failed", error: message });
    console.warn("[judge] failed:", message);
    return null;
  } finally {
    await flushTraces().catch(() => {});
  }
}

const stamp = (iso: string) => iso.replace("T", " ").replace("Z", "");

async function persist(j: Judgement): Promise<void> {
  await insert("chat_judgements", [
    {
      conv_id: j.convId,
      seq: j.seq,
      question: j.question,
      asked_at: stamp(j.askedAt),
      judged_at: stamp(j.judgedAt),
      overall: j.overall,
      relevance_verdict: j.relevance.verdict,
      relevance_score: j.relevance.score,
      relevance_reason: j.relevance.reason,
      sql_verdict: j.sql.verdict,
      sql_score: j.sql.score,
      sql_reason: j.sql.reason,
      findings_json: JSON.stringify(j.findings),
      queries_json: JSON.stringify(j.queries),
      model: j.model,
      answer_trace_url: j.answerTraceUrl ?? "",
      judge_trace_url: j.judgeTraceUrl ?? "",
    },
  ]);
}

// ── serial queue ─────────────────────────────────────────────────
// Three people demoing at once must not fire three judge calls into the same
// rate limit as the answers they are waiting on.

let chain: Promise<unknown> = Promise.resolve();

/** Fire-and-forget. Returns immediately; failures are swallowed by judgeAnswer. */
export function enqueueJudgement(input: JudgeInput): void {
  chain = chain.then(() => judgeAnswer(input)).catch(() => undefined);
}

// ── read side ────────────────────────────────────────────────────

export async function listJudgements(limit = 50): Promise<Judgement[]> {
  await initJudgeTable();
  const rows = await query<Record<string, unknown>>(`
    SELECT conv_id, toUInt32(seq) AS seq, question,
           toString(asked_at) AS asked_at, toString(judged_at) AS judged_at,
           overall, relevance_verdict, relevance_score, relevance_reason,
           sql_verdict, sql_score, sql_reason, findings_json, queries_json,
           model, answer_trace_url, judge_trace_url
    FROM chat_judgements FINAL
    ORDER BY judged_at DESC LIMIT ${Math.floor(limit)}
  `);

  const parse = <T>(raw: unknown, fallback: T): T => {
    try {
      return JSON.parse(String(raw ?? "")) as T;
    } catch {
      return fallback;
    }
  };

  return rows.map((r) => ({
    convId: String(r["conv_id"] ?? ""),
    seq: Number(r["seq"] ?? 0),
    question: String(r["question"] ?? ""),
    askedAt: String(r["asked_at"] ?? ""),
    judgedAt: String(r["judged_at"] ?? ""),
    overall: String(r["overall"] ?? "pass") as Verdict,
    relevance: {
      verdict: String(r["relevance_verdict"] ?? "pass") as Verdict,
      score: Number(r["relevance_score"] ?? 0),
      reason: String(r["relevance_reason"] ?? ""),
    },
    sql: {
      verdict: String(r["sql_verdict"] ?? "pass") as Verdict,
      score: Number(r["sql_score"] ?? 0),
      reason: String(r["sql_reason"] ?? ""),
    },
    findings: parse<Finding[]>(r["findings_json"], []),
    queries: parse<Judgement["queries"]>(r["queries_json"], []),
    model: String(r["model"] ?? ""),
    answerTraceUrl: String(r["answer_trace_url"] ?? "") || null,
    judgeTraceUrl: String(r["judge_trace_url"] ?? "") || null,
  }));
}
