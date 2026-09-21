import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_DEFAULT_MODEL,
  GEMINI_DEFAULT_MODEL,
  GEMINI_OPENAI_BASE_URL,
  env,
  isRealKey,
  requireVar,
  resolveAnalyticsFlags,
  resolveLlmConfig,
} from "../../src/core/env.js";

/**
 * Importing env.ts must never throw — these tests run in a clean checkout with
 * no .env — and the backend choice must follow the documented precedence so a
 * pasted key switches providers without any other edit.
 */

const REAL_GEMINI = "AIzaSyD-example-key-0123456789abcdef";
const REAL_ANTHROPIC = "sk-ant-api03-example-0123456789abcdef";

test("the module imports without any env populated (required vars resolve lazily)", () => {
  // If the import had thrown we would not be here; the getter throws on use, naming the var.
  assert.throws(() => requireVar("CLICKHOUSE_URL", {}), /Missing env var CLICKHOUSE_URL/);
  assert.throws(() => requireVar("LANGFUSE_SECRET_KEY", { LANGFUSE_SECRET_KEY: "   " }), /LANGFUSE_SECRET_KEY/);
  assert.throws(
    () => requireVar("CLICKHOUSE_URL", { CLICKHOUSE_URL: "https://xxxxx" }),
    /CLICKHOUSE_URL/,
    "an .env.example placeholder counts as missing",
  );
  assert.equal(requireVar("CLICKHOUSE_URL", { CLICKHOUSE_URL: "https://a.b:8443" }), "https://a.b:8443");
});

test("isRealKey rejects the placeholders shipped in .env.example", () => {
  assert.equal(isRealKey(undefined), false);
  assert.equal(isRealKey(""), false);
  assert.equal(isRealKey("sk-ant-"), false);
  assert.equal(isRealKey("pk-lf-"), false);
  assert.equal(isRealKey("a-long-enough-value-xxxxx"), false);
  assert.equal(isRealKey(REAL_ANTHROPIC), true);
  assert.equal(isRealKey(REAL_GEMINI), true);
});

test("precedence: explicit LLM_PROVIDER → real GEMINI_API_KEY → real ANTHROPIC_API_KEY → Claude Code OAuth", () => {
  const none = resolveLlmConfig({});
  assert.equal(none.provider, "anthropic-oauth");
  assert.equal(none.backend, "claude-code-oauth");
  assert.equal(none.apiKey, null);
  assert.equal(none.model, CLAUDE_DEFAULT_MODEL);

  const placeholder = resolveLlmConfig({ ANTHROPIC_API_KEY: "sk-ant-" });
  assert.equal(placeholder.provider, "anthropic-oauth", "the 7-char placeholder is not a key");
  assert.equal(placeholder.apiKey, null);

  const anthropic = resolveLlmConfig({ ANTHROPIC_API_KEY: REAL_ANTHROPIC });
  assert.equal(anthropic.provider, "anthropic");
  assert.equal(anthropic.backend, "anthropic-api");
  assert.equal(anthropic.apiKey, REAL_ANTHROPIC);
  assert.equal(anthropic.model, CLAUDE_DEFAULT_MODEL);

  const gemini = resolveLlmConfig({ GEMINI_API_KEY: REAL_GEMINI, ANTHROPIC_API_KEY: REAL_ANTHROPIC });
  assert.equal(gemini.provider, "gemini", "a Gemini key wins over an Anthropic key");
  assert.equal(gemini.backend, "gemini-openai-compatible");
  assert.equal(gemini.apiKey, REAL_GEMINI);
  assert.equal(gemini.model, GEMINI_DEFAULT_MODEL);
  assert.equal(gemini.baseUrl, GEMINI_OPENAI_BASE_URL);

  const forced = resolveLlmConfig({ LLM_PROVIDER: "anthropic", GEMINI_API_KEY: REAL_GEMINI, ANTHROPIC_API_KEY: REAL_ANTHROPIC });
  assert.equal(forced.provider, "anthropic", "an explicit provider beats key precedence");
  assert.equal(forced.apiKey, REAL_ANTHROPIC);

  const oauth = resolveLlmConfig({ LLM_PROVIDER: "anthropic-oauth", ANTHROPIC_API_KEY: REAL_ANTHROPIC });
  assert.equal(oauth.provider, "anthropic-oauth");
  assert.equal(oauth.apiKey, null, "the OAuth path never carries an API key");

  const geminiNoKey = resolveLlmConfig({ LLM_PROVIDER: "gemini" });
  assert.equal(geminiNoKey.provider, "gemini");
  assert.equal(geminiNoKey.apiKey, null, "resolution never throws for a missing key — the first call does");

  assert.equal(resolveLlmConfig({ LLM_PROVIDER: " Gemini " }).provider, "gemini", "case/space-insensitive");
  assert.equal(resolveLlmConfig({ LLM_PROVIDER: "claude-code" }).provider, "anthropic-oauth");
  assert.throws(() => resolveLlmConfig({ LLM_PROVIDER: "cohere" }), /Unknown LLM_PROVIDER "cohere"/);
});

test("model, base URL, concurrency, timeout, seed and effort come from their env vars with the documented defaults", () => {
  const base = { GEMINI_API_KEY: REAL_GEMINI };
  const d = resolveLlmConfig(base);
  assert.equal(d.maxConcurrency, 3);
  assert.equal(d.timeoutMs, 240_000);
  assert.equal(d.temperature, 0);
  assert.equal(d.seed, null, "seed is only sent when LLM_SEED is set");
  assert.equal(
    d.reasoningEffort,
    "low",
    'Gemini defaults to "low": with thinking off the pipeline produced a figure an independent query contradicted',
  );

  // Non-Gemini paths send no effort field — it is an OpenAI-compatible-only knob.
  assert.equal(resolveLlmConfig({ ANTHROPIC_API_KEY: REAL_ANTHROPIC }).reasoningEffort, null);

  const custom = resolveLlmConfig({
    ...base,
    GEMINI_MODEL: "gemini-3.5-flash-lite",
    LLM_BASE_URL: "https://api.groq.com/openai/v1/",
    LLM_MAX_CONCURRENCY: "1",
    LLM_TIMEOUT_MS: "120000",
    LLM_SEED: "42",
    LLM_REASONING_EFFORT: "low",
  });
  assert.equal(custom.model, "gemini-3.5-flash-lite");
  assert.equal(custom.baseUrl, "https://api.groq.com/openai/v1", "trailing slash stripped");
  assert.equal(custom.maxConcurrency, 1);
  assert.equal(custom.timeoutMs, 120_000);
  assert.equal(custom.seed, 42);
  assert.equal(custom.reasoningEffort, "low");

  const junk = resolveLlmConfig({ ...base, LLM_MAX_CONCURRENCY: "zero", LLM_TIMEOUT_MS: "-5", LLM_SEED: "abc", LLM_REASONING_EFFORT: "  " });
  assert.equal(junk.maxConcurrency, 3, "unparseable → default");
  assert.equal(junk.timeoutMs, 240_000, "non-positive → default");
  assert.equal(junk.seed, null);
  assert.equal(junk.reasoningEffort, "low", "blank → the Gemini default, not an empty field");

  assert.equal(resolveLlmConfig({ ANTHROPIC_API_KEY: REAL_ANTHROPIC, CLICKWRIGHT_MODEL: "claude-opus-5" }).model, "claude-opus-5");
  assert.equal(
    resolveLlmConfig({ GEMINI_API_KEY: REAL_GEMINI, CLICKWRIGHT_MODEL: "claude-opus-5" }).model,
    GEMINI_DEFAULT_MODEL,
    "CLICKWRIGHT_MODEL does not leak into the Gemini path",
  );
  assert.equal(resolveLlmConfig({}).maxConcurrency, 8, "the Claude Code path keeps its unthrottled default");
  assert.equal(resolveLlmConfig({ LLM_MAX_CONCURRENCY: "2" }).maxConcurrency, 2);
});

test("analytics flags default ON and each is an opt-out via =0", () => {
  assert.deepEqual(resolveAnalyticsFlags({}), {
    qualityGate: true,
    llmLookup: true,
    relatedInsights: true,
    orderByAll: true,
  });
  assert.deepEqual(resolveAnalyticsFlags({ ANALYTICS_QUALITY_GATE: "1", ANALYTICS_LLM_LOOKUP: "true" }), {
    qualityGate: true,
    llmLookup: true,
    relatedInsights: true,
    orderByAll: true,
  });
  assert.deepEqual(
    resolveAnalyticsFlags({
      ANALYTICS_QUALITY_GATE: "0",
      ANALYTICS_LLM_LOOKUP: "0",
      ANALYTICS_RELATED_INSIGHTS: "0",
      ANALYTICS_ORDER_BY_ALL: "0",
    }),
    { qualityGate: false, llmLookup: false, relatedInsights: false, orderByAll: false },
  );
});

test("env.analytics re-reads process.env on every access", () => {
  const before = process.env["ANALYTICS_QUALITY_GATE"];
  try {
    delete process.env["ANALYTICS_QUALITY_GATE"];
    assert.equal(env.analytics.qualityGate, true);
    process.env["ANALYTICS_QUALITY_GATE"] = "0";
    assert.equal(env.analytics.qualityGate, false);
  } finally {
    if (before === undefined) delete process.env["ANALYTICS_QUALITY_GATE"];
    else process.env["ANALYTICS_QUALITY_GATE"] = before;
  }
});

test("optional ClickHouse fields have their defaults without touching required ones", () => {
  // These getters read process.env directly; defaults apply when unset. They must
  // not require CLICKHOUSE_URL to be present.
  const savedUser = process.env["CLICKHOUSE_USER"];
  try {
    delete process.env["CLICKHOUSE_USER"];
    assert.equal(env.clickhouse.username, "default");
  } finally {
    if (savedUser === undefined) delete process.env["CLICKHOUSE_USER"];
    else process.env["CLICKHOUSE_USER"] = savedUser;
  }
});
