import { config } from "dotenv";
import { fileURLToPath } from "node:url";

// Resolve backend/.env relative to this module, not the cwd — scripts can be
// launched from the repo root or backend/ interchangeably. A missing file is
// fine: dotenv leaves process.env alone and every required var is resolved
// lazily below, so importing this module never throws (npm test runs offline
// in a clean checkout).
config({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });

export type EnvSource = Record<string, string | undefined>;

/** A required var, read at first use. Throws with the var's name — never its value. */
export function requireVar(name: string, src: EnvSource = process.env): string {
  const value = src[name];
  if (!value || value.trim() === "" || value.endsWith("xxxxx")) {
    throw new Error(`Missing env var ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

function optional(name: string, fallback: string, src: EnvSource = process.env): string {
  const value = src[name];
  return value && value.trim() !== "" ? value : fallback;
}

function positiveInt(name: string, fallback: number, src: EnvSource): number {
  const raw = src[name];
  if (!raw || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * "Real" credential: longer than the `sk-ant-` / `pk-lf-` style placeholders
 * (.env.example ships 6–7 char prefixes) and not an `xxxxx` stand-in.
 */
export function isRealKey(value: string | undefined): value is string {
  if (!value) return false;
  const trimmed = value.trim();
  return trimmed.length > 15 && !trimmed.endsWith("xxxxx");
}

// ── LLM provider ─────────────────────────────────────────────────

export type LlmProvider = "gemini" | "anthropic" | "anthropic-oauth";
export type LlmBackend = "gemini-openai-compatible" | "anthropic-api" | "claude-code-oauth";

export interface LlmConfig {
  provider: LlmProvider;
  /** Human-readable backend id, as shown by /api/health and check-env. */
  backend: LlmBackend;
  /** Gemini or Anthropic key; null on the Claude Code OAuth path. */
  apiKey: string | null;
  model: string;
  /** OpenAI-compatible root (no trailing slash); `/chat/completions` is appended. */
  baseUrl: string;
  /** In-flight LLM calls across the whole process. */
  maxConcurrency: number;
  /** Per-attempt timeout for the HTTP providers. */
  timeoutMs: number;
  /** Sent on the OpenAI-compatible path only. */
  temperature: number;
  /** Only sent when LLM_SEED is set — Gemini 400s on unknown fields. */
  seed: number | null;
  /** `reasoning_effort` for the OpenAI-compatible path; only sent when set. */
  reasoningEffort: string | null;
}

// Measured against the live API (21 Sep 2026) on a free Google AI Studio key:
// gemini-3.8-flash is capped at 20 requests per DAY on the free tier
// (GenerateRequestsPerDayPerProjectPerModel-FreeTier) — one analytics question is
// 5-7 calls, so a single run exhausts it and the next dies in rate-limit retries.
// gemini-3.1-flash-lite answered in 1.2-1.5 s and accepts `reasoning_effort`;
// gemini-3.5-flash works but takes 11-17 s (and 503s when effort is sent), and
// the 2.5 models 404. Newer models tend to ship with the lowest daily caps.
export const GEMINI_DEFAULT_MODEL = "gemini-3.1-flash-lite";
export const CLAUDE_DEFAULT_MODEL = "claude-sonnet-5";
export const GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

const PROVIDER_ALIASES: Record<string, LlmProvider> = {
  gemini: "gemini",
  google: "gemini",
  openai: "gemini", // any OpenAI-compatible host, pointed at by LLM_BASE_URL
  "openai-compatible": "gemini",
  anthropic: "anthropic",
  claude: "anthropic",
  "anthropic-oauth": "anthropic-oauth",
  oauth: "anthropic-oauth",
  "claude-code": "anthropic-oauth",
  "agent-sdk": "anthropic-oauth",
};

export const BACKEND_LABEL: Record<LlmProvider, LlmBackend> = {
  gemini: "gemini-openai-compatible",
  anthropic: "anthropic-api",
  "anthropic-oauth": "claude-code-oauth",
};

/**
 * Pure: which model backend to use, from an env-shaped record.
 *
 * Precedence: an explicit `LLM_PROVIDER`, else a real `GEMINI_API_KEY`, else a
 * real `ANTHROPIC_API_KEY`, else the Claude Agent SDK, which authenticates with
 * the machine's Claude Code login. Never throws for a missing key — the call
 * site reports that at the first request, so /api/health can still answer.
 */
export function resolveLlmConfig(src: EnvSource): LlmConfig {
  const geminiKey = isRealKey(src["GEMINI_API_KEY"]) ? src["GEMINI_API_KEY"].trim() : null;
  const anthropicKey = isRealKey(src["ANTHROPIC_API_KEY"]) ? src["ANTHROPIC_API_KEY"].trim() : null;

  const explicit = src["LLM_PROVIDER"]?.trim().toLowerCase();
  let provider: LlmProvider;
  if (explicit) {
    const known = PROVIDER_ALIASES[explicit];
    if (!known) {
      throw new Error(
        `Unknown LLM_PROVIDER "${src["LLM_PROVIDER"]}" — use gemini, anthropic or anthropic-oauth`,
      );
    }
    provider = known;
  } else if (geminiKey) {
    provider = "gemini";
  } else if (anthropicKey) {
    provider = "anthropic";
  } else {
    provider = "anthropic-oauth";
  }

  const seedRaw = src["LLM_SEED"]?.trim();
  const seed = seedRaw && /^-?\d+$/.test(seedRaw) ? Number.parseInt(seedRaw, 10) : null;
  const effort = src["LLM_REASONING_EFFORT"]?.trim();

  return {
    provider,
    backend: BACKEND_LABEL[provider],
    apiKey: provider === "gemini" ? geminiKey : provider === "anthropic" ? anthropicKey : null,
    model:
      provider === "gemini"
        ? optional("GEMINI_MODEL", GEMINI_DEFAULT_MODEL, src)
        : optional("CLICKWRIGHT_MODEL", CLAUDE_DEFAULT_MODEL, src),
    baseUrl: optional("LLM_BASE_URL", GEMINI_OPENAI_BASE_URL, src).replace(/\/+$/, ""),
    // Gemini's free tier is ~15 requests/min, so three in flight is the useful
    // cap. The Claude Code path spawns a subprocess per call and never
    // rate-limits; its default leaves it as it always ran (one question uses ≤4
    // concurrent calls).
    maxConcurrency: positiveInt("LLM_MAX_CONCURRENCY", provider === "anthropic-oauth" ? 8 : 3, src),
    // 4 minutes. The Claude Code path narrates in 30-90 s, so a 90 s deadline sat
    // on the observed tail and turned slow-but-fine calls into failures; the
    // retry loop in core/llm.ts gives a call that does hit this another attempt.
    timeoutMs: positiveInt("LLM_TIMEOUT_MS", 240_000, src),
    temperature: 0,
    seed,
    // Default "low" on the Gemini path, deliberately. Measured 21 Sep 2026 on the
    // coupon question: with thinking off the pipeline answered 30.3% and an
    // independently written query disagreed (confidence low 0.14); with "low" it
    // answered 27.6%, reproduced to the digit (high 0.79). ~10 s per question for
    // a correct answer. `LLM_REASONING_EFFORT=none` opts out.
    reasoningEffort: effort ? effort : provider === "gemini" ? "low" : null,
  };
}

// ── analytics feature flags ──────────────────────────────────────

export interface AnalyticsFlags {
  /** LLM quality gate + narration revision pass. `ANALYTICS_QUALITY_GATE=0` disables. */
  qualityGate: boolean;
  /** LLM-as-retriever knowledge lookup (else deterministic term match). `ANALYTICS_LLM_LOOKUP=0` disables. */
  llmLookup: boolean;
  /** Related cached insights from other conversations in the narrator prompt. `ANALYTICS_RELATED_INSIGHTS=0` disables. */
  relatedInsights: boolean;
  /** `ORDER BY ALL` before the fetch cap so capped rows are deterministic. `ANALYTICS_ORDER_BY_ALL=0` disables. */
  orderByAll: boolean;
}

/** Pure: every flag is on unless explicitly set to "0" — opt-out escape hatches, not features to enable. */
export function resolveAnalyticsFlags(src: EnvSource): AnalyticsFlags {
  return {
    qualityGate: src["ANALYTICS_QUALITY_GATE"] !== "0",
    llmLookup: src["ANALYTICS_LLM_LOOKUP"] !== "0",
    relatedInsights: src["ANALYTICS_RELATED_INSIGHTS"] !== "0",
    orderByAll: src["ANALYTICS_ORDER_BY_ALL"] !== "0",
  };
}

// ── the env object ───────────────────────────────────────────────

let llmCache: LlmConfig | null = null;

/**
 * Every field is a getter, so `import { env }` is free of side effects and a
 * missing credential surfaces where it is first needed (with the var's name),
 * not at module load. Call sites read `env.clickhouse.url` etc. exactly as before.
 */
export const env = {
  clickhouse: {
    get url(): string {
      return requireVar("CLICKHOUSE_URL");
    },
    get username(): string {
      return optional("CLICKHOUSE_USER", "default");
    },
    get password(): string {
      return process.env["CLICKHOUSE_PASSWORD"] ?? "";
    },
    get database(): string {
      return optional("CLICKHOUSE_DATABASE", "default");
    },
    // ClickHouse Cloud keeps system.query_log per replica; clusterAllReplicas()
    // over this cluster unions them. Measured on our service: the local table
    // sees roughly half the queries. See src/observe/query-log.ts.
    get cluster(): string {
      return optional("CLICKHOUSE_CLUSTER", "default");
    },
  },
  langfuse: {
    get publicKey(): string {
      return requireVar("LANGFUSE_PUBLIC_KEY");
    },
    get secretKey(): string {
      return requireVar("LANGFUSE_SECRET_KEY");
    },
    get baseUrl(): string {
      return optional("LANGFUSE_BASE_URL", "https://cloud.langfuse.com");
    },
  },
  /**
   * Resolved once, at first use. On the Claude Code OAuth path `ANTHROPIC_API_KEY`
   * is scrubbed from process.env — whatever it holds — so the Agent SDK's
   * subprocess can't pick it up. A *real* key is the case that matters: leaving it
   * in place silently bills the run to the API while /api/health and every trace
   * report `claude-code-oauth`. Choosing this path is choosing the subscription.
   */
  get llm(): LlmConfig {
    if (!llmCache) {
      llmCache = resolveLlmConfig(process.env);
      if (llmCache.provider === "anthropic-oauth") {
        delete process.env["ANTHROPIC_API_KEY"];
      }
    }
    return llmCache;
  },
  /** Re-read on every access so a script can flip a flag between runs. */
  get analytics(): AnalyticsFlags {
    return resolveAnalyticsFlags(process.env);
  },
};
