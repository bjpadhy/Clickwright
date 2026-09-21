/**
 * Benchmark the analytics pipeline in-process: wall time, LLM calls and tokens,
 * rate-limit retries, confidence, and determinism — one CSV row per run.
 *
 *   npx tsx scripts/bench-analytics.ts --tag gemini-flash --runs 3
 *   npx tsx scripts/bench-analytics.ts --tag baseline --q P1,S6q1 --out bench.csv
 *   npx tsx scripts/bench-analytics.ts --questions my.json      # [{ "id", "question" }]
 *   GEMINI_MODEL=gemini-3.5-flash-lite npx tsx scripts/bench-analytics.ts --tag flash-lite --runs 3
 *
 * Every run bypasses the insight cache (`noCache`) so it measures the pipeline,
 * not the replay. Question starts are paced ≥ 60 s apart by default — the Gemini
 * free tier allows ~15 requests/min and one question makes 5–7 calls;
 * `--pace-ms 0` disables. Determinism across runs = distinct `headline_sha8` /
 * `sqlset_sha8` per question (see the summary on stderr). CSV goes to stdout and,
 * with `--out`, is appended to that file (header written once).
 */
import { createHash } from "node:crypto";
import { appendFile, readFile, stat } from "node:fs/promises";
import { runAnalytics, type Insight } from "../src/agents/analytics.js";
import { closeDb } from "../src/core/db.js";
import { env } from "../src/core/env.js";
import { endRun, flushTraces, startRun, traceUrl, withRunSink, type RunEvent } from "../src/core/tracing.js";

interface BenchQuestion {
  id: string;
  question: string;
}

/** The 7 saved probe questions: the 4 standard probes + the spec-06 PM questions. */
const DEFAULT_QUESTIONS: BenchQuestion[] = [
  { id: "P1", question: "Analyze the existing funnel and surface the most important issues, with the why." },
  { id: "P2", question: "Where are we losing conversions, and for which segments (device / geo / destination)?" },
  { id: "P3", question: "Are there any regressions or trends over the last quarter?" },
  { id: "P4", question: "Is anything in the base context wrong, stale, or self-contradictory?" },
  {
    id: "S6q1",
    question: "Coupon apply rate (field_shown → coupon_applied) and valid vs rejected mix; top reject reasons.",
  },
  {
    id: "S6q2",
    question:
      "Conversion lift: do coupon users reach checkout_with_coupon at a higher rate than the no-coupon baseline (rows where coupon_code is null)?",
  },
  { id: "S6q3", question: "Margin cost: total discount_amount; which codes drive volume vs erode margin." },
];

const COLUMNS = [
  "tag",
  "qid",
  "run",
  "wall_ms",
  "llm_calls",
  "llm_ms_sum",
  "in_tokens",
  "out_tokens",
  "retries_429",
  "confidence_value",
  "confidence_score",
  "verification_agreed",
  "sql_attempts",
  "headline_sha8",
  "sqlset_sha8",
  "truncated",
  "error",
] as const;

type Row = Record<(typeof COLUMNS)[number], string | number>;

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  return value !== undefined && !value.startsWith("--") ? value : null;
}

const sha8 = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 8);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const csvCell = (v: string | number): string => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface RunStats {
  llmCalls: number;
  llmMsSum: number;
  inTokens: number;
  outTokens: number;
  retries429: number;
  sqlAttempts: number;
  truncated: number;
}

/** The run's own events — the same stream the chat UI renders — are the measurement. */
function collector(stats: RunStats): (e: RunEvent) => void {
  return (e) => {
    if (e.type === "log" && e.name === "llm_done") {
      stats.llmCalls++;
      stats.llmMsSum += num(e.payload["elapsedMs"]);
      stats.inTokens += num(e.payload["inputTokens"]);
      stats.outTokens += num(e.payload["outputTokens"]);
      if (e.payload["finishReason"] === "length") stats.truncated++;
    } else if (e.type === "log" && e.name === "llm_retry") {
      if (e.payload["status"] === 429) stats.retries429++;
    } else if (e.type === "step_start" && /^sql_attempt_\d+$/.test(e.name)) {
      stats.sqlAttempts++;
    }
  };
}

async function benchOne(tag: string, q: BenchQuestion, run: number): Promise<Row> {
  const trace = startRun(
    `bench:${tag}`,
    { qid: q.id, run, question: q.question, provider: env.llm.provider, model: env.llm.model },
    { sessionId: `bench-${tag}` },
  );
  const stats: RunStats = { llmCalls: 0, llmMsSum: 0, inTokens: 0, outTokens: 0, retries429: 0, sqlAttempts: 0, truncated: 0 };
  const t0 = Date.now();
  let insight: Insight | null = null;
  let error = "";
  try {
    insight = await withRunSink(collector(stats), () =>
      runAnalytics({ question: q.question, noCache: true }, { trace }),
    );
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const wallMs = Date.now() - t0;
  const sqlset = insight ? sha8([...insight.sql.map((s) => s.query)].sort().join("\n;\n")) : "";
  endRun(trace, { wall_ms: wallMs, ...stats, ...(error ? { error } : {}) }, { bench: tag, qid: q.id, run });

  console.error(
    `  ${q.id.padEnd(5)} run ${run}  ${(wallMs / 1000).toFixed(1).padStart(6)} s · ${stats.llmCalls} calls · ` +
      (insight
        ? `${insight.confidence.value} ${insight.confidence.score.toFixed(2)} · verified=${String(insight.verification?.agreed ?? "n/a")}`
        : `FAILED ${error.slice(0, 100)}`) +
      `  ${traceUrl(trace)}`,
  );

  return {
    tag,
    qid: q.id,
    run,
    wall_ms: wallMs,
    llm_calls: stats.llmCalls,
    llm_ms_sum: stats.llmMsSum,
    in_tokens: stats.inTokens,
    out_tokens: stats.outTokens,
    retries_429: stats.retries429,
    confidence_value: insight?.confidence.value ?? "",
    confidence_score: insight?.confidence.score ?? "",
    verification_agreed: insight?.verification ? String(insight.verification.agreed) : "",
    sql_attempts: stats.sqlAttempts,
    headline_sha8: insight ? sha8(insight.headline) : "",
    sqlset_sha8: sqlset,
    truncated: stats.truncated,
    error,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

async function main() {
  const tag = arg("tag") ?? `bench-${Date.now().toString(36)}`;
  const runs = Math.max(1, Number.parseInt(arg("runs") ?? "1", 10) || 1);
  const paceMs = Math.max(0, Number.parseInt(arg("pace-ms") ?? "60000", 10) || 0);
  const out = arg("out");
  const only = arg("q")?.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) ?? null;

  const questionsFile = arg("questions");
  let questions: BenchQuestion[] = questionsFile
    ? (JSON.parse(await readFile(questionsFile, "utf8")) as BenchQuestion[])
    : DEFAULT_QUESTIONS;
  if (only) questions = questions.filter((q) => only.includes(q.id.toLowerCase()));
  if (questions.length === 0) {
    console.error("no questions selected — check --q / --questions");
    process.exit(1);
  }

  console.error(
    `bench "${tag}" · ${questions.length} questions × ${runs} runs · provider=${env.llm.provider} model=${env.llm.model}` +
      ` · pace ${paceMs} ms · cache bypassed`,
  );

  const header = COLUMNS.join(",");
  console.log(header);
  if (out) {
    const empty = await stat(out).then((s) => s.size === 0).catch(() => true);
    if (empty) await appendFile(out, `${header}\n`);
  }

  const rows: Row[] = [];
  let lastStart = 0;
  try {
    for (let run = 1; run <= runs; run++) {
      for (const q of questions) {
        const wait = lastStart ? paceMs - (Date.now() - lastStart) : 0;
        if (wait > 0) {
          console.error(`  … pacing ${(wait / 1000).toFixed(0)} s before ${q.id}`);
          await sleep(wait);
        }
        lastStart = Date.now();
        const row = await benchOne(tag, q, run);
        rows.push(row);
        const line = COLUMNS.map((c) => csvCell(row[c])).join(",");
        console.log(line);
        if (out) await appendFile(out, `${line}\n`);
      }
    }
  } finally {
    // Summary: determinism is the count of distinct headline / SQL-set digests per question.
    console.error("\nsummary (per question): runs · median wall · distinct headline_sha8 · distinct sqlset_sha8 · failures");
    for (const q of questions) {
      const mine = rows.filter((r) => r.qid === q.id);
      if (mine.length === 0) continue;
      const okRows = mine.filter((r) => !r.error);
      const heads = new Set(okRows.map((r) => r.headline_sha8));
      const sqls = new Set(okRows.map((r) => r.sqlset_sha8));
      console.error(
        `  ${q.id.padEnd(5)} ${mine.length} · ${(median(mine.map((r) => Number(r.wall_ms))) / 1000).toFixed(1)} s · ` +
          `${heads.size} · ${sqls.size} · ${mine.length - okRows.length}`,
      );
    }
    await flushTraces();
    await closeDb();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
