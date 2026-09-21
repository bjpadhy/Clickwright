/**
 * Verifies ClickHouse, Langfuse, and the LLM are all reachable with the current .env.
 * Run this before anything else — green checks mean the team is unblocked.
 *
 *   npm run check-env             # config summary + ClickHouse + LLM smoke/JSON/determinism + Langfuse
 *   npm run check-env -- --burst  # also fire 5 concurrent calls to exercise the concurrency gate
 *
 * Never prints a credential: keys appear as a 6-char prefix and their length.
 */
import { query, closeDb } from "../src/core/db.js";
import { startRun, flushTraces, withRunSink, type RunEvent } from "../src/core/tracing.js";
import { complete, stripFences, LlmTruncatedError, type CompleteOptions } from "../src/core/llm.js";
import { env } from "../src/core/env.js";
import type { Ctx } from "../src/core/tracing.js";

const BASE_TABLES = [
  "destination_card_clicked",
  "application_started",
  "document_uploaded",
  "purchase_completed",
  "search_typed",
  "landing_page_scrolled",
  "auth_completed",
  "pay_now_clicked",
];

const burst = process.argv.includes("--burst");

interface CallStats {
  elapsedMs: number;
  inputTokens: number;
  outputTokens: number;
  attempts: number;
  retries: number;
  queued: number;
  finishReason: string | null;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function newStats(): CallStats {
  return { elapsedMs: 0, inputTokens: 0, outputTokens: 0, attempts: 1, retries: 0, queued: 0, finishReason: null };
}

/** Feed `llm_*` run events into `stats` — the same events the UI's step log shows. */
function collect(stats: CallStats, verbose = true): (e: RunEvent) => void {
  return (e) => {
    if (e.type !== "log") return;
    if (e.name === "llm_retry") {
      stats.retries++;
      if (verbose) {
        console.log(
          `    ↻ attempt ${String(e.payload["attempt"])} failed (${String(e.payload["status"] ?? "?")}), ` +
            `retrying in ${num(e.payload["delayMs"])} ms — ${String(e.payload["reason"] ?? "")}`,
        );
      }
    } else if (e.name === "llm_queued") {
      stats.queued++;
    } else if (e.name === "llm_done") {
      stats.elapsedMs += num(e.payload["elapsedMs"]);
      stats.inputTokens += num(e.payload["inputTokens"]);
      stats.outputTokens += num(e.payload["outputTokens"]);
      stats.attempts = num(e.payload["attempts"]) || 1;
      stats.finishReason = typeof e.payload["finishReason"] === "string" ? e.payload["finishReason"] : null;
    }
  };
}

async function timedCall(
  trace: Ctx,
  name: string,
  prompt: string,
  options: CompleteOptions,
): Promise<{ text: string; stats: CallStats }> {
  const stats = newStats();
  const text = await withRunSink(collect(stats), () => complete(trace, name, prompt, options));
  return { text, stats };
}

const describe = (s: CallStats): string =>
  `${(s.elapsedMs / 1000).toFixed(1)} s · ${s.inputTokens}→${s.outputTokens} tokens` +
  (s.attempts > 1 ? ` · ${s.attempts} attempts` : "") +
  (s.retries > 0 ? ` · ${s.retries} retries` : "");

function keyPrefix(key: string | null): string {
  return key ? `${key.slice(0, 6)}…(${key.length} chars)` : "(none — Claude Code login)";
}

/** 400s from an OpenAI-compatible host usually name the offending field. */
function adviseOn400(message: string): void {
  if (/\bseed\b/i.test(message)) console.log("  ⚠ the endpoint rejected `seed` — unset LLM_SEED");
  if (/reasoning_effort/i.test(message)) {
    console.log("  ⚠ the endpoint rejected `reasoning_effort` — unset LLM_REASONING_EFFORT or pick a value it accepts");
  }
  if (/response_format/i.test(message)) {
    console.log("  ⚠ the endpoint rejected `response_format` — this model may not support JSON mode");
  }
}

function reportLlmFailure(label: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof LlmTruncatedError) {
    console.log(`✗ ${label}  output truncated at max_tokens (${error.outputTokens} tokens)`);
    console.log("  ⚠ if this is a Gemini thinking model, thoughts count against max_tokens — try LLM_REASONING_EFFORT=low");
    return;
  }
  console.log(`✗ ${label}  ${message}`);
  adviseOn400(message);
}

async function main() {
  let failed = false;

  // 0 — resolved LLM config (no secrets)
  const llm = env.llm;
  console.log(`LLM config    provider=${llm.provider} · backend=${llm.backend} · model=${llm.model}`);
  if (llm.provider === "gemini") console.log(`              baseUrl=${llm.baseUrl}`);
  console.log(
    `              key=${keyPrefix(llm.apiKey)} · concurrency=${llm.maxConcurrency} · timeout=${llm.timeoutMs} ms` +
      (llm.seed !== null ? ` · seed=${llm.seed}` : "") +
      (llm.reasoningEffort ? ` · reasoning_effort=${llm.reasoningEffort}` : ""),
  );
  const flags = env.analytics;
  console.log(
    `Analytics     quality_gate=${flags.qualityGate} · llm_lookup=${flags.llmLookup} · ` +
      `related_insights=${flags.relatedInsights} · order_by_all=${flags.orderByAll}`,
  );
  console.log();

  // 1 — ClickHouse
  try {
    const versionRows = await query<{ version: string }>("SELECT version() AS version");
    console.log(`✓ ClickHouse  ${versionRows[0]?.version ?? "?"}  (${env.clickhouse.database})`);

    const tables = await query<{ name: string; rows: string }>(
      `SELECT name, total_rows AS rows FROM system.tables
       WHERE database = '${env.clickhouse.database}' ORDER BY name`,
    );
    const present = new Set(tables.map((t) => t.name));
    const missing = BASE_TABLES.filter((t) => !present.has(t));

    if (tables.length === 0) {
      console.log("  ⚠ no tables yet — run the Atlys data/load.sh first");
    } else {
      for (const t of tables) {
        console.log(`    ${t.name.padEnd(28)} ${Number(t.rows).toLocaleString()} rows`);
      }
    }
    if (missing.length > 0) {
      console.log(`  ⚠ missing base tables: ${missing.join(", ")}`);
    }

    // The fetch cap appends `ORDER BY ALL` for deterministic row order (ClickHouse ≥ 23.12).
    try {
      await query("SELECT 1 AS a ORDER BY ALL LIMIT 1");
      console.log("✓ ORDER BY ALL  supported");
    } catch (error) {
      console.log(`⚠ ORDER BY ALL  not supported (${(error as Error).message.split("\n")[0]})`);
      console.log("  → set ANALYTICS_ORDER_BY_ALL=0 so the fetch cap falls back to a plain LIMIT");
    }
  } catch (error) {
    failed = true;
    console.log(`✗ ClickHouse  ${(error as Error).message}`);
  }

  // 2 — LLM (smoke, JSON mode, determinism) + 3 — Langfuse (the same trace proves it)
  const trace = startRun("check-env", { purpose: "connectivity smoke test", provider: llm.provider });

  try {
    const { text, stats } = await timedCall(trace, "smoke-test", "Reply with exactly: ok", { maxTokens: 64 });
    console.log(`✓ LLM smoke   ${llm.model} → "${text.trim().slice(0, 40)}"  (${describe(stats)})`);
  } catch (error) {
    failed = true;
    reportLlmFailure("LLM smoke ", error);
  }

  try {
    const { text, stats } = await timedCall(
      trace,
      "json-mode",
      'Return exactly this JSON object and nothing else: {"ok":true}',
      { maxTokens: 64, json: true },
    );
    let ok = false;
    try {
      ok = (JSON.parse(stripFences(text)) as { ok?: unknown }).ok === true;
    } catch {
      ok = false;
    }
    if (ok) console.log(`✓ LLM JSON    parsed {"ok":true}  (${describe(stats)})`);
    else {
      failed = true;
      console.log(`✗ LLM JSON    got ${JSON.stringify(text.slice(0, 80))} — not the requested object`);
    }
  } catch (error) {
    failed = true;
    reportLlmFailure("LLM JSON  ", error);
  }

  // Informational: temperature 0 is near- but not bit-exact on every provider.
  // Served answers are stable regardless (insight cache); this shows the raw noise.
  try {
    const sqlPrompt =
      "Write one ClickHouse SQL statement that counts events per day from a table named `events` " +
      "with a DateTime column `ts`, newest day first. Return only the SQL, no prose, no code fences.";
    const a = await timedCall(trace, "determinism-1", sqlPrompt, { maxTokens: 200 });
    const b = await timedCall(trace, "determinism-2", sqlPrompt, { maxTokens: 200 });
    const same = stripFences(a.text) === stripFences(b.text);
    console.log(
      same
        ? `✓ determinism identical SQL across two calls  (${describe(a.stats)} / ${describe(b.stats)})`
        : `ℹ determinism outputs differ — temperature-0 sampling noise on this provider  (${describe(a.stats)} / ${describe(b.stats)})`,
    );
  } catch (error) {
    reportLlmFailure("determinism", error);
  }

  // Optional: 5 concurrent calls through the semaphore — expect (5 − concurrency) to queue.
  if (burst) {
    const stats = newStats();
    const t0 = Date.now();
    try {
      await withRunSink(collect(stats, false), () =>
        Promise.all(
          [1, 2, 3, 4, 5].map((i) =>
            complete(trace, `burst-${i}`, `Reply with exactly the number ${i}`, { maxTokens: 16 }),
          ),
        ),
      );
      console.log(
        `✓ burst       5 calls in ${((Date.now() - t0) / 1000).toFixed(1)} s · limit ${llm.maxConcurrency} · ` +
          `${stats.queued} waited for a slot · ${stats.retries} retries · ${stats.inputTokens}→${stats.outputTokens} tokens`,
      );
    } catch (error) {
      reportLlmFailure("burst     ", error);
    }
  }

  try {
    await flushTraces();
    console.log(`✓ Langfuse    trace sent to ${env.langfuse.baseUrl}`);
  } catch (error) {
    failed = true;
    console.log(`✗ Langfuse    ${(error as Error).message}`);
  }

  await closeDb();
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
