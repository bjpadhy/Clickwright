import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LlmBlockedError,
  LlmHttpError,
  LlmTimeoutError,
  LlmTruncatedError,
  backoffDelayMs,
  buildOpenAiChatBody,
  createSemaphore,
  describeHttpError,
  estimateUsage,
  isDailyQuotaBody,
  isRetryableLlmError,
  parseOpenAiChatResponse,
  parseRetryAfterMs,
  retryWithBackoff,
} from "../../src/core/llm-transport.js";

/**
 * The transport is what stands between a free-tier 429 and a dead answer: the
 * semaphore keeps the request rate inside quota, the backoff waits exactly as
 * long as the provider asked, and the parser turns silent truncation into a
 * retryable, model-readable error.
 */

const noSleep = { sleep: async () => {}, jitter: false } as const;
const deferred = <T = void>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
/** Drain the microtask queue: a release hands the slot over across several
 * awaits, so counting individual ticks would make these tests brittle. */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

// ── semaphore ────────────────────────────────────────────────────

test("semaphore never lets more than `limit` tasks run at once and releases in FIFO order", async () => {
  const gate = createSemaphore(2);
  const started: number[] = [];
  const gates = [deferred(), deferred(), deferred(), deferred()];
  const queuedAt: number[] = [];

  const tasks = gates.map((g, i) =>
    gate.run(
      async () => {
        started.push(i);
        await g.promise;
      },
      (waiting) => queuedAt.push(waiting),
    ),
  );
  await settle();
  assert.deepEqual(started, [0, 1], "only two start immediately");
  assert.equal(gate.active, 2);
  assert.equal(gate.waiting, 2);
  assert.deepEqual(queuedAt, [1, 2], "onQueued reports the queue depth at enqueue time");

  gates[0]!.resolve();
  await settle();
  assert.deepEqual(started, [0, 1, 2], "the first waiter goes next, not the last");
  assert.equal(gate.active, 2, "the freed slot is taken, not doubled up");

  gates[1]!.resolve();
  gates[2]!.resolve();
  gates[3]!.resolve();
  await Promise.all(tasks);
  assert.equal(gate.active, 0);
  assert.equal(gate.waiting, 0);
});

test("semaphore releases the slot when the task throws", async () => {
  const gate = createSemaphore(1);
  await assert.rejects(gate.run(async () => {
    throw new Error("boom");
  }));
  assert.equal(gate.active, 0);
  let ran = false;
  await gate.run(async () => {
    ran = true;
  });
  assert.ok(ran, "a later task still acquires the slot");
});

// ── backoff ──────────────────────────────────────────────────────

test("retries a 429 and a 503, then succeeds; sleeps grow 2 s → 4 s", async () => {
  const sleeps: number[] = [];
  const retried: number[] = [];
  let calls = 0;
  const result = await retryWithBackoff(
    async (attempt) => {
      calls++;
      if (attempt === 1) throw new LlmHttpError(429, "slow down");
      if (attempt === 2) throw new LlmHttpError(503, "overloaded");
      return "ok";
    },
    {
      jitter: false,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      onRetry: ({ attempt }) => retried.push(attempt),
    },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [2000, 4000]);
  assert.deepEqual(retried, [1, 2]);
});

test("honours the provider's Retry-After hint over the exponential schedule", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  await retryWithBackoff(
    async () => {
      calls++;
      if (calls === 1) throw new LlmHttpError(429, "", 7000);
      return "ok";
    },
    { ...noSleep, sleep: async (ms) => void sleeps.push(ms) },
  );
  assert.deepEqual(sleeps, [7000]);
});

test("aroundSleep wraps every wait, so the caller can free a resource while it sleeps", async () => {
  const gate = createSemaphore(1);
  const order: string[] = [];
  let calls = 0;
  await gate.run(() =>
    retryWithBackoff(
      async () => {
        order.push(`attempt:${gate.active}`);
        if (++calls < 3) throw new LlmHttpError(429, "");
        return "ok";
      },
      {
        ...noSleep,
        sleep: async () => void order.push(`sleep:${gate.active}`),
        aroundSleep: async (wait) => {
          gate.release();
          try {
            await wait();
          } finally {
            await gate.acquire();
          }
        },
      },
    ),
  );
  assert.deepEqual(order, ["attempt:1", "sleep:0", "attempt:1", "sleep:0", "attempt:1"]);
  assert.equal(gate.active, 0, "the slot is still balanced once the call finishes");
});

test("caps any wait at maxMs and adds bounded jitter", () => {
  const long = new LlmHttpError(429, "", 120_000);
  assert.equal(backoffDelayMs(1, long, { baseMs: 2000, maxMs: 30_000, jitter: false, random: () => 0 }), 30_000);
  const late = backoffDelayMs(10, new LlmHttpError(503, ""), { baseMs: 2000, maxMs: 30_000, jitter: false, random: () => 0 });
  assert.equal(late, 30_000, "exponential schedule is capped too");
  const jittered = backoffDelayMs(1, new LlmHttpError(503, ""), { baseMs: 2000, maxMs: 30_000, jitter: true, random: () => 1 });
  assert.equal(jittered, 2500, "jitter adds at most 25% of baseMs");
});

test("stops after three attempts and rethrows the last error untouched", async () => {
  let calls = 0;
  const last = new LlmHttpError(500, "still down");
  await assert.rejects(
    retryWithBackoff(async () => {
      calls++;
      throw calls < 3 ? new LlmHttpError(429, "") : last;
    }, noSleep),
    (err: unknown) => err === last,
  );
  assert.equal(calls, 3);
});

test("does not retry 400, 401, 404, aborts, blocks or truncation", async () => {
  const cases: unknown[] = [
    new LlmHttpError(400, "bad field"),
    new LlmHttpError(401, "nope"),
    new LlmHttpError(404, "no model"),
    Object.assign(new Error("aborted"), { name: "AbortError" }),
    Object.assign(new Error("timed out"), { name: "TimeoutError" }),
    new LlmBlockedError("content_filter"),
    new LlmTruncatedError("partial", { inputTokens: 1, outputTokens: 2, estimated: false }),
    new Error("Agent SDK call failed: error_max_turns"),
  ];
  for (const error of cases) {
    let calls = 0;
    await assert.rejects(
      retryWithBackoff(async () => {
        calls++;
        throw error;
      }, noSleep),
    );
    assert.equal(calls, 1, `${(error as Error).name ?? "error"} must not be retried`);
    assert.equal(isRetryableLlmError(error), false);
  }
});

test("classifies network failures and SDK-shaped `status` errors like our own", () => {
  assert.equal(isRetryableLlmError(new TypeError("fetch failed")), true);
  assert.equal(isRetryableLlmError(Object.assign(new Error("rate limited"), { status: 429 })), true);
  assert.equal(isRetryableLlmError(Object.assign(new Error("overloaded"), { status: 529 })), true);
  assert.equal(isRetryableLlmError(Object.assign(new Error("bad request"), { status: 400 })), false);
  assert.equal(isRetryableLlmError(Object.assign(new Error("conn"), { name: "APIConnectionError" })), true);
  assert.equal(isRetryableLlmError(Object.assign(new Error("abort"), { name: "APIUserAbortError" })), false);
  assert.equal(
    isRetryableLlmError(new LlmTimeoutError(240_000)),
    true,
    "our own per-attempt deadline is retried, unlike a caller's abort",
  );
  assert.equal(isRetryableLlmError(new LlmHttpError(408, "")), true);
  assert.equal(isRetryableLlmError(new LlmHttpError(409, "")), true);
});

// ── Retry-After parsing ──────────────────────────────────────────

test("parseRetryAfterMs reads delta-seconds, HTTP-dates, Gemini retryDelay and message text", () => {
  const now = Date.parse("2026-09-21T10:00:00Z");
  assert.equal(parseRetryAfterMs(new Headers({ "retry-after": "12" })), 12_000);
  assert.equal(parseRetryAfterMs({ "Retry-After": "1.5" }), 1500);
  assert.equal(
    parseRetryAfterMs(new Headers({ "retry-after": "Mon, 21 Sep 2026 10:00:30 GMT" }), null, now),
    30_000,
  );
  assert.equal(
    parseRetryAfterMs(new Headers({ "retry-after": "Mon, 21 Sep 2026 09:00:00 GMT" }), null, now),
    0,
    "a date in the past means no wait, never a negative one",
  );
  const geminiBody = JSON.stringify({
    error: {
      code: 429,
      message: "You exceeded your current quota. Please retry in 41.2s.",
      details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "41s" }],
    },
  });
  assert.equal(parseRetryAfterMs(new Headers(), geminiBody), 41_000);
  assert.equal(parseRetryAfterMs(null, "quota hit — please retry in 3.5s"), 3500);
  assert.equal(parseRetryAfterMs(new Headers(), "{}"), null);
  assert.equal(parseRetryAfterMs(undefined, undefined), null);
});

// ── body builder ─────────────────────────────────────────────────

test("body builder: system first, temperature 0, response_format only in JSON mode, optional fields only when set", () => {
  const plain = buildOpenAiChatBody({ model: "gemini-3.8-flash", prompt: "hi", system: "be terse" });
  assert.deepEqual(plain["messages"], [
    { role: "system", content: "be terse" },
    { role: "user", content: "hi" },
  ]);
  assert.equal(plain["temperature"], 0);
  assert.equal(plain["max_tokens"], 8000);
  assert.equal("response_format" in plain, false);
  assert.equal("seed" in plain, false);
  assert.equal("reasoning_effort" in plain, false);

  const json = buildOpenAiChatBody({ model: "m", prompt: "p", json: true, maxTokens: 1500, temperature: 0.2, seed: 7, reasoningEffort: "low" });
  assert.deepEqual(json["response_format"], { type: "json_object" });
  assert.deepEqual(json["messages"], [{ role: "user", content: "p" }], "no system message when none given");
  assert.equal(json["max_tokens"], 1500);
  assert.equal(json["temperature"], 0.2);
  assert.equal(json["seed"], 7);
  assert.equal(json["reasoning_effort"], "low");

  const nulls = buildOpenAiChatBody({ model: "m", prompt: "p", seed: null, reasoningEffort: null, system: null });
  assert.equal("seed" in nulls, false);
  assert.equal("reasoning_effort" in nulls, false);
});

// ── response parser ──────────────────────────────────────────────

const response = (over: Record<string, unknown> = {}, usage: Record<string, unknown> | null = { prompt_tokens: 120, completion_tokens: 30 }) => ({
  id: "x",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "SELECT 1" }, ...over }],
  ...(usage ? { usage } : {}),
});

test("parser maps text and usage; missing usage is estimated at ~4 chars/token", () => {
  const ok = parseOpenAiChatResponse(response(), 400);
  assert.deepEqual(ok, { text: "SELECT 1", inputTokens: 120, outputTokens: 30, estimated: false, finishReason: "stop" });

  const est = parseOpenAiChatResponse(response({}, null), 400);
  assert.equal(est.estimated, true);
  assert.deepEqual({ inputTokens: est.inputTokens, outputTokens: est.outputTokens }, estimateUsage(400, "SELECT 1".length));
  assert.equal(est.inputTokens, 100);
  assert.equal(est.outputTokens, 2);
});

test("parser joins content parts and tolerates a null content", () => {
  const parts = parseOpenAiChatResponse(
    response({ message: { role: "assistant", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }),
    10,
  );
  assert.equal(parts.text, "ab");
  const empty = parseOpenAiChatResponse(response({ message: { role: "assistant", content: null } }), 10);
  assert.equal(empty.text, "");
});

test("parser: empty choices and content_filter become LlmBlockedError, length becomes LlmTruncatedError with usage", () => {
  assert.throws(() => parseOpenAiChatResponse({ choices: [] }, 10), LlmBlockedError);
  assert.throws(
    () => parseOpenAiChatResponse({ choices: [], promptFeedback: { blockReason: "SAFETY" } }, 10),
    (err: unknown) => err instanceof LlmBlockedError && err.reason === "SAFETY",
  );
  assert.throws(() => parseOpenAiChatResponse(response({ finish_reason: "content_filter" }), 10), LlmBlockedError);

  assert.throws(
    () => parseOpenAiChatResponse(response({ finish_reason: "length" }), 10),
    (err: unknown) =>
      err instanceof LlmTruncatedError &&
      err.text === "SELECT 1" &&
      err.inputTokens === 120 &&
      err.outputTokens === 30 &&
      /cut off/.test(err.message) &&
      /concisely/.test(err.message),
  );
  assert.throws(() => parseOpenAiChatResponse(response({ finish_reason: "MAX_TOKENS" }), 10), LlmTruncatedError);
  assert.equal(isRetryableLlmError(new LlmBlockedError("x")), false);
});

// ── error wording ────────────────────────────────────────────────

test("describeHttpError names the failure class and the env var to check", () => {
  const ctx = { provider: "Gemini", model: "gemini-3.8-flash", keyVar: "GEMINI_API_KEY" };
  const bad = describeHttpError(400, JSON.stringify({ error: { message: "Unknown name \"seed\": Cannot find field." } }), ctx);
  assert.match(bad, /^Gemini rejected the request \(400\): Unknown name "seed"/);
  assert.match(describeHttpError(401, "{}", ctx), /authentication failed \(401\) — check GEMINI_API_KEY/);
  assert.match(describeHttpError(403, "", ctx), /check GEMINI_API_KEY/);
  assert.match(describeHttpError(404, "not found", ctx), /unknown model "gemini-3.8-flash"/);
  assert.match(describeHttpError(429, "quota", { ...ctx, retryAfterMs: 41_000 }), /rate-limited.*429, retry after 41 s/);
  assert.match(describeHttpError(503, "busy", ctx), /server error \(503\): busy/);

  const longBody = "x".repeat(1000);
  assert.ok(describeHttpError(400, longBody, ctx).length < 400, "body is clipped to ~300 chars");
});

// ── a daily cap is not a burst ───────────────────────────────────

test("a per-day 429 is not retried, and says what to do about it", () => {
  // Both kinds of exhaustion are status 429 and mean opposite things. A
  // per-minute 429 clears in seconds; a per-day one clears tomorrow, and
  // retrying it three times with backoff spends ~35 s per call to reach the
  // same answer — on every remaining call of the question.
  const daily = JSON.stringify([
    {
      error: {
        code: 429,
        message:
          "You exceeded your current quota.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 500, model: gemini-3.1-flash-lite",
        details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }],
      },
    },
  ]);
  assert.equal(isDailyQuotaBody(daily), true);
  assert.equal(isRetryableLlmError(new LlmHttpError(429, daily, 38_000)), false);

  const message = describeHttpError(429, daily, {
    provider: "gemini",
    model: "gemini-3.1-flash-lite",
    keyVar: "GEMINI_API_KEY",
    retryAfterMs: 38_000,
  });
  assert.match(message, /daily free-tier quota is exhausted/);
  assert.match(message, /per model/);
  // the per-minute retryDelay must NOT be presented as the time until reset
  assert.doesNotMatch(message, /retry after 38 s/);
});

test("an ordinary burst 429 is still retried with its hint", () => {
  const burst = JSON.stringify({
    error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", details: [{ retryDelay: "12s" }] },
  });
  assert.equal(isDailyQuotaBody(burst), false);
  assert.equal(isRetryableLlmError(new LlmHttpError(429, burst, 12_000)), true);
  assert.match(
    describeHttpError(429, burst, { provider: "gemini", model: "m", keyVar: "K", retryAfterMs: 12_000 }),
    /retry after 12 s/,
  );
});

test("an empty body cannot be mistaken for a daily cap", () => {
  assert.equal(isDailyQuotaBody(""), false);
  assert.equal(isRetryableLlmError(new LlmHttpError(429, "")), true);
});
