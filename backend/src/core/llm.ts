import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env, type LlmConfig } from "./env.js";
import {
  LlmHttpError,
  LlmTimeoutError,
  LlmTruncatedError,
  buildOpenAiChatBody,
  createSemaphore,
  describeHttpError,
  isAbortError,
  parseOpenAiChatResponse,
  parseRetryAfterMs,
  retryWithBackoff,
  statusOf,
  type Semaphore,
} from "./llm-transport.js";
import { emitRunEvent, type Ctx } from "./tracing.js";

export { LlmBlockedError, LlmHttpError, LlmTimeoutError, LlmTruncatedError } from "./llm-transport.js";

let anthropic: Anthropic | null = null;

function client(apiKey: string): Anthropic {
  // maxRetries 0: retries live in one place (retryWithBackoff below) so every
  // attempt is visible as an `llm_retry` event and counted on the generation.
  // That loop also owns the deadline — the SDK's own 600 s timeout never fires
  // because every attempt is handed an `AbortSignal.timeout(LLM_TIMEOUT_MS)`,
  // and a deadline that does fire is retried like any other transient failure.
  anthropic ??= new Anthropic({ apiKey, maxRetries: 0 });
  return anthropic;
}

/**
 * Reasoning effort is pinned, never inherited.
 *
 * The Agent SDK loads the machine's ~/.claude settings by default, so whatever
 * `effortLevel` the developer runs Claude Code at silently became the pipeline's
 * effort too — measured at xhigh: ~5 minutes and ~10 output tokens/sec for a
 * 2.8k-token DDL proposal, with the ~8s of process startup lost in the noise.
 * These prompts are tightly specified and schema-validated, so medium is the
 * right trade, and pinning it keeps runs comparable across machines.
 */
const EFFORT = "medium" as const;

/** What every provider hands back; `complete()` turns it into events + the trace. */
export interface ProviderResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** Usage was not reported and is ~4 chars/token. */
  estimated: boolean;
  finishReason: string | null;
}

type Provider = (prompt: string, options: CompleteOptions, signal: AbortSignal) => Promise<ProviderResult>;

/** Direct Anthropic API — a real `ANTHROPIC_API_KEY`. */
async function completeViaAnthropic(
  prompt: string,
  options: CompleteOptions,
  signal: AbortSignal,
): Promise<ProviderResult> {
  const cfg = env.llm;
  if (!cfg.apiKey) {
    throw new Error("LLM_PROVIDER=anthropic needs a real ANTHROPIC_API_KEY in backend/.env");
  }
  const response = await client(cfg.apiKey).messages.create(
    {
      model: cfg.model,
      max_tokens: options.maxTokens ?? 8000,
      output_config: { effort: EFFORT },
      // `temperature` is NOT sent: on claude-sonnet-5 and every other current
      // model a non-default sampling parameter is rejected with a 400.
      ...(options.system ? { system: options.system } : {}),
      messages: [{ role: "user", content: prompt }],
    },
    { signal },
  );
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
  const usage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    estimated: false,
  };
  if (response.stop_reason === "max_tokens") throw new LlmTruncatedError(text, usage);
  return { text, ...usage, finishReason: response.stop_reason };
}

/**
 * No API key → company Claude Code plan: call through the Claude Agent SDK,
 * which authenticates with the machine's Claude Code OAuth login. Single-turn,
 * no tools — behaves like a plain completion. The abort signal is deliberately
 * not wired in: this path takes 30–90 s per narration and has always run
 * without a deadline.
 */
async function completeViaAgentSdk(
  prompt: string,
  options: CompleteOptions,
  _signal: AbortSignal,
): Promise<ProviderResult> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const stream = query({
    prompt,
    options: {
      model: env.llm.model,
      effort: EFFORT,
      // No tools are allowed, but the CLI can split long responses across
      // assistant turns — maxTurns: 1 intermittently dies with
      // error_max_turns on big prompts (seen in trace pipeline:01_express_checkout).
      maxTurns: 8,
      allowedTools: [],
      ...(options.system ? { customSystemPrompt: options.system } : {}),
    },
  });
  for await (const message of stream) {
    if (message.type === "result") {
      if (message.subtype !== "success") {
        throw new Error(`Agent SDK call failed: ${message.subtype}`);
      }
      // Subscription (OAuth) auth doesn't meter tokens — usage comes back as
      // zeros or per-turn fragments. Prefer reported numbers when sane
      // (includes cache reads/writes); otherwise estimate at ~4 chars/token so
      // Langfuse dashboards stay meaningful. Estimates are labeled as such.
      const u = message.usage as {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens?: number | null;
        cache_read_input_tokens?: number | null;
      };
      const reportedIn =
        u.input_tokens +
        (u.cache_creation_input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0);
      const estIn = Math.ceil(prompt.length / 4);
      const estOut = Math.ceil(message.result.length / 4);
      const estimated = reportedIn < estIn * 0.2 || u.output_tokens < estOut * 0.2;
      return {
        text: message.result,
        inputTokens: estimated ? estIn : reportedIn,
        outputTokens: estimated ? estOut : u.output_tokens,
        estimated,
        finishReason: null,
      };
    }
  }
  throw new Error("Agent SDK stream ended without a result message");
}

function endpointLabel(cfg: LlmConfig): string {
  return cfg.baseUrl.includes("googleapis.com") ? "Gemini" : "OpenAI-compatible endpoint";
}

/**
 * Gemini (or any OpenAI-compatible host via LLM_BASE_URL) over plain `fetch`:
 * POST {baseUrl}/chat/completions with a Bearer key. Non-2xx → `LlmHttpError`
 * carrying the provider's Retry-After hint; 2xx → parsed text + usage.
 */
async function completeViaOpenAiCompatible(
  prompt: string,
  options: CompleteOptions,
  signal: AbortSignal,
): Promise<ProviderResult> {
  const cfg = env.llm;
  if (!cfg.apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set — create a free key in Google AI Studio and add it to backend/.env " +
        "(or pick another backend with LLM_PROVIDER)",
    );
  }
  const body = buildOpenAiChatBody({
    model: cfg.model,
    prompt,
    system: options.system ?? null,
    maxTokens: options.maxTokens ?? 8000,
    temperature: options.temperature ?? cfg.temperature,
    json: options.json ?? false,
    seed: cfg.seed,
    reasoningEffort: cfg.reasoningEffort,
  });
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  const raw = await res.text();
  if (!res.ok) {
    const retryAfterMs = parseRetryAfterMs(res.headers, raw);
    throw new LlmHttpError(
      res.status,
      raw.slice(0, 2000),
      retryAfterMs,
      describeHttpError(res.status, raw, {
        provider: endpointLabel(cfg),
        model: cfg.model,
        keyVar: "GEMINI_API_KEY",
        retryAfterMs,
      }),
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${endpointLabel(cfg)} returned a non-JSON 2xx body: ${raw.slice(0, 200)}`);
  }
  return parseOpenAiChatResponse(json, prompt.length);
}

function providerFor(cfg: LlmConfig): Provider {
  switch (cfg.provider) {
    case "gemini":
      return completeViaOpenAiCompatible;
    case "anthropic":
      return completeViaAnthropic;
    case "anthropic-oauth":
      return completeViaAgentSdk;
  }
}

let gate: Semaphore | null = null;
/** Process-wide cap on in-flight LLM calls. It wraps the retry loop, but the slot
 * is handed back around each backoff sleep (see `aroundSleep` below) — otherwise
 * three concurrent 429s would idle the whole process for the length of the wait. */
function llmGate(cfg: LlmConfig): Semaphore {
  gate ??= createSemaphore(cfg.maxConcurrency);
  return gate;
}

const PROMPT_DIR = fileURLToPath(new URL("../../prompts", import.meta.url));
const promptCache = new Map<string, string>();

/** Prompts live in prompts/*.txt so tuning never means editing TypeScript. */
export async function loadPrompt(
  name: string,
  vars: Record<string, string> = {},
): Promise<string> {
  let template = promptCache.get(name);
  if (template === undefined) {
    template = await readFile(path.join(PROMPT_DIR, `${name}.txt`), "utf8");
    promptCache.set(name, template);
  }
  const rendered = Object.entries(vars).reduce(
    (text, [key, value]) => text.replaceAll(`{{${key}}}`, value),
    template,
  );
  // An unfilled placeholder means the prompt and its call site have drifted apart;
  // sending "{{spec}}" to the model would degrade output invisibly.
  const leftover = [...new Set(rendered.match(/\{\{\w+\}\}/g) ?? [])];
  if (leftover.length > 0) {
    throw new Error(
      `prompt ${name} has unfilled placeholders: ${leftover.join(", ")} — the call site is missing these variables`,
    );
  }
  return rendered;
}

export type CompleteOptions = {
  system?: string;
  maxTokens?: number;
  /** Honoured on the OpenAI-compatible path only (default 0); Claude rejects it. */
  temperature?: number;
  /** Set false to skip the shared system prompt (prompts/system.txt). */
  useSystemPrompt?: boolean;
  /** Ask for a JSON object (`response_format: json_object` on the OpenAI-compatible
   * path; ignored elsewhere). Use for every call the caller will JSON.parse. */
  json?: boolean;
  /** Per-attempt deadline for the HTTP providers; default LLM_TIMEOUT_MS (240 s). */
  timeoutMs?: number;
};

let systemPrompt: string | null = null;
async function sharedSystem(): Promise<string> {
  systemPrompt ??= await readFile(path.join(PROMPT_DIR, "shared_system.txt"), "utf8");
  return systemPrompt;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Single entry point for every LLM call, so model config and tracing stay in one place.
 * The generation is recorded on the trace with prompt, completion, and token usage.
 *
 * Dispatch: semaphore → backoff loop (3 tries; 429/5xx/network/deadline only,
 * honouring Retry-After) → provider with a per-attempt timeout. The slot is
 * released while the loop sleeps. Run events: `llm_start`,
 * `llm_queued` (waited for a slot), `llm_progress` (every 3 s), `llm_retry`,
 * then `llm_done` or `llm_error`.
 */
export async function complete(
  parent: Ctx,
  name: string,
  prompt: string,
  options: CompleteOptions = {},
): Promise<string> {
  const cfg = env.llm;
  const model = cfg.model;
  if (options.useSystemPrompt !== false && !options.system) {
    options = { ...options, system: await sharedSystem() };
  }
  const timeoutMs = options.timeoutMs ?? cfg.timeoutMs;
  const generation = parent.generation({
    name,
    model,
    input: prompt,
    metadata: {
      provider: cfg.provider,
      backend: cfg.backend,
      ...(options.system ? { system: options.system } : {}),
      ...(options.json ? { json_mode: true } : {}),
    },
  });

  const log = (eventName: string, payload: Record<string, unknown>): void =>
    emitRunEvent({ type: "log", name: eventName, payload: { call: name, ...payload } });

  // A generation can run for a minute with nothing to show. Emit a progress tick
  // so the UI can display "thinking… 12s" instead of an inert spinner.
  const startedAt = Date.now();
  log("llm_start", { promptChars: prompt.length, provider: cfg.provider });
  const ticker = setInterval(() => {
    log("llm_progress", { elapsedMs: Date.now() - startedAt });
  }, 3000);

  let attempts = 0;
  try {
    const provider = providerFor(cfg);
    const slots = llmGate(cfg);
    const queued = (waiting: number): void => log("llm_queued", { waiting, limit: cfg.maxConcurrency });
    const result = await slots.run(
      () =>
        retryWithBackoff(
          async (attempt) => {
            attempts = attempt;
            const deadline = AbortSignal.timeout(timeoutMs);
            try {
              return await provider(prompt, options, deadline);
            } catch (error) {
              // The error's name can't tell a deadline from a caller's cancel —
              // the Anthropic SDK rewraps every abort as APIUserAbortError — but
              // our own signal can. Only the deadline is worth another attempt.
              if (deadline.aborted && isAbortError(error)) throw new LlmTimeoutError(timeoutMs, error);
              throw error;
            }
          },
          {
            tries: 3,
            // 15 s rather than the transport default: a provider hint of minutes
            // is better spent failing and retrying the whole question.
            maxMs: 15_000,
            // Give the slot back while waiting, and queue for one again before
            // the next attempt, so a rate-limited call doesn't block the others.
            aroundSleep: async (wait) => {
              slots.release();
              try {
                await wait();
              } finally {
                await slots.acquire(queued);
              }
            },
            onRetry: ({ attempt, error, delayMs }) =>
              log("llm_retry", {
                attempt,
                delayMs,
                status: statusOf(error),
                reason: errorMessage(error).slice(0, 200),
              }),
          },
        ),
      queued,
    );

    clearInterval(ticker);
    const usage = { input: result.inputTokens, output: result.outputTokens };
    log("llm_done", {
      elapsedMs: Date.now() - startedAt,
      outputChars: result.text.length,
      inputTokens: usage.input,
      outputTokens: usage.output,
      provider: cfg.provider,
      attempts,
      finishReason: result.finishReason,
      ...(result.estimated ? { usageEstimated: true } : {}),
    });
    generation.end({
      output: result.text,
      usage,
      metadata: {
        provider: cfg.provider,
        finish_reason: result.finishReason,
        attempts,
        ...(result.estimated
          ? { usage_source: "estimated ~4 chars/token (provider reported no usage)" }
          : {}),
      },
    });
    return result.text;
  } catch (error) {
    clearInterval(ticker);
    const elapsedMs = Date.now() - startedAt;

    if (error instanceof LlmTruncatedError) {
      // The provider did answer — record what it said so the trace shows the
      // truncation, then let retryWithFeedback shorten the next attempt.
      const usage = { input: error.inputTokens, output: error.outputTokens };
      log("llm_done", {
        elapsedMs,
        outputChars: error.text.length,
        inputTokens: usage.input,
        outputTokens: usage.output,
        provider: cfg.provider,
        attempts,
        finishReason: "length",
        truncated: true,
        ...(error.estimated ? { usageEstimated: true } : {}),
      });
      generation.end({
        output: error.text,
        usage,
        level: "WARNING",
        statusMessage: error.message,
        metadata: { provider: cfg.provider, finish_reason: "length", attempts },
      });
      throw error;
    }

    const status = statusOf(error);
    let failure: unknown = error;
    if (error instanceof LlmTimeoutError || isAbortError(error)) {
      failure = new Error(
        `LLM call "${name}" timed out after ${Math.round(timeoutMs / 1000)} s (${cfg.backend}, attempt ${attempts})`,
        { cause: error },
      );
    } else if (status !== null && !(error instanceof LlmHttpError) && cfg.provider === "anthropic") {
      // Anthropic SDK APIError: same wording as the Gemini path, naming the right key.
      const body = (error as { error?: unknown }).error;
      failure = new Error(
        describeHttpError(status, body ? JSON.stringify(body) : errorMessage(error), {
          provider: "Anthropic",
          model,
          keyVar: "ANTHROPIC_API_KEY",
        }),
        { cause: error },
      );
    }
    log("llm_error", {
      elapsedMs,
      attempts,
      provider: cfg.provider,
      status,
      error: errorMessage(failure),
    });
    generation.end({
      level: "ERROR",
      statusMessage: errorMessage(failure),
      metadata: { provider: cfg.provider, attempts },
    });
    throw failure;
  }
}

/** Models like to wrap output in ```sql fences; strip them before executing. */
export function stripFences(text: string): string {
  const fenced = text.match(/```(?:sql|json|markdown|md)?\s*\n([\s\S]*?)```/);
  return (fenced?.[1] ?? text).trim();
}

/** Split a DDL script into individual statements — ClickHouse takes one at a time. */
export function splitStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));
}
