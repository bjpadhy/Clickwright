/**
 * LLM transport primitives — pure functions and small classes with no env or
 * network access, so every branch is unit-testable without a provider.
 *
 * `core/llm.ts` composes these into `complete()`: a semaphore gates the number
 * of in-flight calls, a backoff loop retries the transient failures a provider
 * can emit (429/5xx/socket resets), and the body builder / response parser
 * speak the OpenAI chat-completions dialect that Gemini's compatibility
 * endpoint (and most hosted models) accept.
 */

// ── error classes ────────────────────────────────────────────────

/** A non-2xx response. `retryAfterMs` is the provider's own hint when it gave one. */
export class LlmHttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly retryAfterMs: number | null;

  constructor(status: number, body: string, retryAfterMs: number | null = null, message?: string) {
    super(message ?? `LLM HTTP ${status}: ${summarizeBody(body)}`);
    this.name = "LlmHttpError";
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

/** The provider refused to answer (safety / content filter / empty choices). Never retried —
 * the same prompt would be blocked again. */
export class LlmBlockedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`LLM blocked the response (${reason}) — the prompt or its context tripped a provider filter`);
    this.name = "LlmBlockedError";
    this.reason = reason;
  }
}

/**
 * The per-attempt deadline (`LLM_TIMEOUT_MS`) elapsed. Distinct from a
 * caller-initiated abort — the provider was slow, not wrong — so it IS retried:
 * narration on the Claude path is measured at 30-90 s and a cold provider can
 * sit on the tail of that. `core/llm.ts` raises this instead of the raw abort,
 * which it recognises by asking its own timeout signal whether it fired (the
 * Anthropic SDK rewraps every abort as `APIUserAbortError`, losing the name).
 */
export class LlmTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, cause?: unknown) {
    super(`the provider did not answer within ${Math.round(timeoutMs / 1000)} s`, { cause });
    this.name = "LlmTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** The completion hit the `max_tokens` budget (`finish_reason: "length"`). The message
 * is written for the model: `retryWithFeedback` feeds it into the next attempt so
 * the retry is shorter instead of failing on the same truncated JSON. */
export class LlmTruncatedError extends Error {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimated: boolean;

  constructor(text: string, usage: { inputTokens: number; outputTokens: number; estimated: boolean }) {
    super(
      `Your previous answer was cut off by the output-length limit after ${usage.outputTokens} tokens ` +
        `(finish_reason=length). Give the same answer more concisely: shorter strings, fewer rows, no repetition.`,
    );
    this.name = "LlmTruncatedError";
    this.text = text;
    this.inputTokens = usage.inputTokens;
    this.outputTokens = usage.outputTokens;
    this.estimated = usage.estimated;
  }
}

// ── classification ───────────────────────────────────────────────

/** `AbortSignal.timeout` fires a TimeoutError, a manual abort an AbortError, and the
 * Anthropic SDK wraps either as APIUserAbortError. None are retried as such — a
 * deadline is only retried once `core/llm.ts` has turned it into `LlmTimeoutError`. */
export function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || err.name === "TimeoutError" || err.name === "APIUserAbortError";
}

/** HTTP status carried by an error, whether ours (`LlmHttpError`) or the Anthropic
 * SDK's `APIError` — both expose a numeric `status`. */
export function statusOf(err: unknown): number | null {
  if (err instanceof LlmHttpError) return err.status;
  if (err && typeof err === "object" && typeof (err as { status?: unknown }).status === "number") {
    return (err as { status: number }).status;
  }
  return null;
}

/**
 * Transient failures worth another attempt: request timeout at the provider (408),
 * conflict (409), rate limit (429), any 5xx, and a network-level failure (`fetch`
 * rejects with a TypeError; the Anthropic SDK with APIConnectionError), plus our
 * own per-attempt deadline (`LlmTimeoutError`). Everything else — 400 bad request,
 * 401/403 auth, 404 model, caller aborts, blocks, truncation — would fail
 * identically next time.
 */
export function isRetryableLlmError(err: unknown): boolean {
  if (err instanceof LlmBlockedError || err instanceof LlmTruncatedError) return false;
  if (err instanceof LlmTimeoutError) return true;
  if (isAbortError(err)) return false;
  const status = statusOf(err);
  if (status !== null) return status === 408 || status === 409 || status === 429 || status >= 500;
  if (err instanceof TypeError) return true;
  if (err instanceof Error && err.name.startsWith("APIConnection")) return true;
  return false;
}

// ── Retry-After ──────────────────────────────────────────────────

type HeaderSource =
  | { get(name: string): string | null }
  | Record<string, string | undefined>
  | null
  | undefined;

function readHeader(headers: HeaderSource, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(name: string): string | null }).get(name);
  }
  const record = headers as Record<string, string | undefined>;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === wanted && value !== undefined) return value;
  }
  return null;
}

/**
 * How long the provider asked us to wait, in ms. Reads the `Retry-After` header
 * (delta-seconds or an HTTP-date), then falls back to the Gemini error body,
 * which carries `error.details[].retryDelay: "12s"` and often "retry in 12.3s"
 * in the message. `null` when nothing usable was said.
 */
export function parseRetryAfterMs(
  headers: HeaderSource,
  body?: string | null,
  now: number = Date.now(),
): number | null {
  const header = readHeader(headers, "retry-after")?.trim();
  if (header) {
    if (/^\d+(\.\d+)?$/.test(header)) return Math.round(Number(header) * 1000);
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { error?: { details?: Array<{ retryDelay?: unknown }> } };
    for (const detail of parsed.error?.details ?? []) {
      const delay = detail?.retryDelay;
      if (typeof delay === "string") {
        const m = /^(\d+(?:\.\d+)?)s$/.exec(delay.trim());
        if (m) return Math.round(Number(m[1]) * 1000);
      }
    }
  } catch {
    // not JSON — fall through to the message scan
  }
  const inText = /retry in (\d+(?:\.\d+)?)\s*s(?:ec|econds)?\b/i.exec(body);
  if (inText) return Math.round(Number(inText[1]) * 1000);
  return null;
}

// ── backoff ──────────────────────────────────────────────────────

export interface RetryOptions {
  /** Total attempts including the first. Default 3. */
  tries?: number;
  /** First delay; doubles per attempt. Default 2 s. */
  baseMs?: number;
  /** Ceiling on any single wait, provider hint included. Default 30 s. */
  maxMs?: number;
  /** Add up to 25% of `baseMs` of random jitter (default true). */
  jitter?: boolean;
  /** Injectable randomness for tests. */
  random?: () => number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Wraps each backoff wait. `complete()` passes the semaphore's release/re-acquire
   * here so a call sitting out a 429 hands its slot to another call instead of
   * holding the whole process at `LLM_MAX_CONCURRENCY` for the length of the wait. */
  aroundSleep?: (wait: () => Promise<void>) => Promise<void>;
  /** Defaults to `isRetryableLlmError`. */
  isRetryable?: (err: unknown) => boolean;
  /** Observed before each wait — the caller turns it into a run event. */
  onRetry?: (info: { attempt: number; error: unknown; delayMs: number }) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait before attempt `attempt + 1`: the provider's hint when it gave one,
 * otherwise exponential from `baseMs`; jittered; never above `maxMs`. */
export function backoffDelayMs(
  attempt: number,
  error: unknown,
  opts: { baseMs: number; maxMs: number; jitter: boolean; random: () => number },
): number {
  const hinted =
    error instanceof LlmHttpError
      ? error.retryAfterMs
      : parseRetryAfterMs((error as { headers?: HeaderSource } | null)?.headers ?? null);
  let delay = hinted ?? opts.baseMs * 2 ** (attempt - 1);
  if (opts.jitter) delay += opts.random() * opts.baseMs * 0.25;
  return Math.min(opts.maxMs, Math.round(delay));
}

/**
 * Run `fn` until it resolves or a non-retryable error / the attempt budget stops
 * it. The last error is rethrown untouched so callers can still classify it.
 */
export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const tries = Math.max(1, opts.tries ?? 3);
  const baseMs = opts.baseMs ?? 2000;
  const maxMs = opts.maxMs ?? 30_000;
  const jitter = opts.jitter ?? true;
  const random = opts.random ?? Math.random;
  const sleep = opts.sleep ?? defaultSleep;
  const retryable = opts.isRetryable ?? isRetryableLlmError;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= tries || !retryable(error)) throw error;
      const delayMs = backoffDelayMs(attempt, error, { baseMs, maxMs, jitter, random });
      opts.onRetry?.({ attempt, error, delayMs });
      const wait = (): Promise<void> => sleep(delayMs);
      if (opts.aroundSleep) await opts.aroundSleep(wait);
      else await wait();
    }
  }
}

// ── semaphore ────────────────────────────────────────────────────

export interface Semaphore {
  /** Run `fn` once a slot is free. `onQueued(waiting)` fires only when it had to wait. */
  run<T>(fn: () => Promise<T>, onQueued?: (waiting: number) => void): Promise<T>;
  /** Take a slot directly. `run` is the safe default; this pair exists so a task
   * that must wait (backoff) can give its slot back and take another afterwards.
   * Every `acquire` needs exactly one `release`, in a `finally`. */
  acquire(onQueued?: (waiting: number) => void): Promise<void>;
  release(): void;
  readonly active: number;
  readonly waiting: number;
  readonly limit: number;
}

/** FIFO counting semaphore. The slot is released in `finally`, so a throwing
 * task never leaks capacity. */
export function createSemaphore(limit: number): Semaphore {
  const cap = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : Number.POSITIVE_INFINITY;
  let active = 0;
  const queue: Array<() => void> = [];

  const acquire = (onQueued?: (waiting: number) => void): Promise<void> =>
    new Promise((resolve) => {
      if (active < cap) {
        active++;
        resolve();
        return;
      }
      queue.push(() => {
        active++;
        resolve();
      });
      onQueued?.(queue.length);
    });

  const release = (): void => {
    active--;
    const next = queue.shift();
    if (next) next();
  };

  return {
    async run(fn, onQueued) {
      await acquire(onQueued);
      try {
        return await fn();
      } finally {
        release();
      }
    },
    acquire,
    release,
    get active() {
      return active;
    },
    get waiting() {
      return queue.length;
    },
    limit: cap,
  };
}

// ── OpenAI chat-completions dialect ──────────────────────────────

export interface OpenAiChatBodyInput {
  model: string;
  prompt: string;
  system?: string | null;
  maxTokens?: number;
  /** Default 0 — the same question should produce the same SQL. */
  temperature?: number;
  /** `response_format: json_object`; only sent when true. */
  json?: boolean;
  /** Only sent when set: Gemini rejects unknown fields with a 400. */
  seed?: number | null;
  /** `reasoning_effort` — only sent when set, for the same reason. */
  reasoningEffort?: string | null;
}

export function buildOpenAiChatBody(input: OpenAiChatBodyInput): Record<string, unknown> {
  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (input.system) messages.push({ role: "system", content: input.system });
  messages.push({ role: "user", content: input.prompt });

  const body: Record<string, unknown> = {
    model: input.model,
    messages,
    max_tokens: input.maxTokens ?? 8000,
    temperature: input.temperature ?? 0,
  };
  if (input.json) body["response_format"] = { type: "json_object" };
  if (input.seed !== undefined && input.seed !== null) body["seed"] = input.seed;
  if (input.reasoningEffort) body["reasoning_effort"] = input.reasoningEffort;
  return body;
}

export interface ParsedChatResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** True when the provider reported no usage and the counts are ~4 chars/token. */
  estimated: boolean;
  finishReason: string | null;
}

/** ~4 chars/token — keeps Langfuse dashboards meaningful when a provider reports no usage. */
export function estimateUsage(promptChars: number, outputChars: number): { inputTokens: number; outputTokens: number } {
  return { inputTokens: Math.ceil(promptChars / 4), outputTokens: Math.ceil(outputChars / 4) };
}

const BLOCKED_FINISH = new Set(["content_filter", "safety", "recitation", "blocklist", "prohibited_content", "spii"]);
const TRUNCATED_FINISH = new Set(["length", "max_tokens"]);

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : ""))
      .join("");
  }
  return "";
}

/**
 * Turn a 2xx chat-completions payload into text + usage. Throws `LlmBlockedError`
 * for an empty/filtered choice and `LlmTruncatedError` when the budget cut the
 * answer off — both carry what the provider did say, for the trace.
 */
export function parseOpenAiChatResponse(json: unknown, promptChars: number): ParsedChatResponse {
  const root = (json ?? {}) as {
    choices?: unknown;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    promptFeedback?: { blockReason?: unknown };
    prompt_feedback?: { block_reason?: unknown };
    error?: unknown;
  };
  if (root.error) {
    throw new Error(`LLM returned an error payload: ${JSON.stringify(root.error).slice(0, 300)}`);
  }
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const choice = choices[0] as
    | { finish_reason?: unknown; message?: { content?: unknown } }
    | undefined;
  if (!choice) {
    const reason = root.promptFeedback?.blockReason ?? root.prompt_feedback?.block_reason ?? "empty choices";
    throw new LlmBlockedError(String(reason));
  }
  const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : null;
  const finishKey = finishReason?.toLowerCase() ?? "";
  if (BLOCKED_FINISH.has(finishKey)) throw new LlmBlockedError(finishReason!);

  const text = contentText(choice.message?.content);
  const promptTokens = root.usage?.prompt_tokens;
  const completionTokens = root.usage?.completion_tokens;
  const reported = typeof promptTokens === "number" && typeof completionTokens === "number";
  const usage = reported
    ? { inputTokens: promptTokens, outputTokens: completionTokens, estimated: false }
    : { ...estimateUsage(promptChars, text.length), estimated: true };

  if (TRUNCATED_FINISH.has(finishKey)) throw new LlmTruncatedError(text, usage);
  return { text, ...usage, finishReason };
}

// ── error wording ────────────────────────────────────────────────

/** The provider's own `error.message` when the body is JSON, else the first 300 chars. */
export function summarizeBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "(empty body)";
  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: unknown } | string; message?: unknown };
    const message =
      typeof parsed.error === "string"
        ? parsed.error
        : typeof parsed.error?.message === "string"
          ? parsed.error.message
          : typeof parsed.message === "string"
            ? parsed.message
            : null;
    if (message) return message.slice(0, 300);
  } catch {
    // plain text body
  }
  return trimmed.slice(0, 300);
}

/**
 * One sentence per failure class, naming the env var to check. 429/5xx are the
 * ones the backoff retries; the rest fail fast with the provider's own words.
 */
export function describeHttpError(
  status: number,
  body: string,
  ctx: { provider: string; model: string; keyVar: string; retryAfterMs?: number | null },
): string {
  const detail = summarizeBody(body);
  if (status === 400) return `${ctx.provider} rejected the request (400): ${detail}`;
  if (status === 401 || status === 403) return `${ctx.provider} authentication failed (${status}) — check ${ctx.keyVar}`;
  if (status === 404) return `${ctx.provider} returned 404 — unknown model "${ctx.model}" or wrong LLM_BASE_URL: ${detail}`;
  if (status === 429) {
    const wait = ctx.retryAfterMs != null ? `, retry after ${Math.ceil(ctx.retryAfterMs / 1000)} s` : "";
    return `${ctx.provider} rate-limited the request (429${wait}): ${detail}`;
  }
  if (status >= 500) return `${ctx.provider} server error (${status}): ${detail}`;
  return `${ctx.provider} HTTP ${status}: ${detail}`;
}
