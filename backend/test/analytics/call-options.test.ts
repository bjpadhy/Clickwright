import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CALL_OPTIONS,
  cacheKey,
  callOptions,
  sanityGate,
  type TaskResult,
} from "../../src/agents/analytics.js";

/**
 * The three deterministic contracts around the pipeline's edges: what a call is
 * allowed to spend, what has to change before an answer is recomputed, and what
 * the sanity gate counts. All pure — no database, no model.
 */

// ── per-call budgets ─────────────────────────────────────────────

test("each call gets a budget that covers its reasoning as well as its output", () => {
  // On the Anthropic API path (`output_config.effort`) and on Gemini, thinking
  // tokens are spent out of the SAME max_tokens as the answer. Sized to the
  // visible output alone, `quality` truncated into the all-pass stub and `verify`
  // truncated to `agreed: null`, which made "high" confidence unreachable — 13
  // truncations across one four-question walkthrough. Headroom is free: the cap
  // is a cap, not a reservation (a one-word answer under a 65,536 cap reports
  // completion_tokens: 1), so these are sized for reasoning plus output.
  assert.deepEqual(callOptions("plan"), { maxTokens: 16000, json: true });
  assert.deepEqual(callOptions("verify"), { maxTokens: 16000, json: true });
  assert.deepEqual(callOptions("narrate"), { maxTokens: 32000, json: true });
  assert.deepEqual(callOptions("quality"), { maxTokens: 12000, json: true });
});

test("no call is budgeted below the room a reasoning pass needs", () => {
  for (const name of ["plan", "sql_t1", "verify", "narrate", "quality", "context_lookup"]) {
    assert.ok(
      (callOptions(name).maxTokens ?? 0) >= 12000,
      `${name} is too tight to survive a thinking model`,
    );
  }
});

test("every per-task SQL call shares one budget and never asks for JSON", () => {
  // The SQL writer returns a bare statement; JSON mode would wrap it in an object.
  for (const name of ["sql_t1", "sql_t2", "sql_funnel_step"]) {
    assert.deepEqual(callOptions(name), { maxTokens: 16000 }, name);
    assert.equal("json" in callOptions(name), false, name);
  }
});

test("an unknown call name falls back to the old budget rather than a tight one", () => {
  // A new call site that nobody added here must not be silently truncated.
  assert.deepEqual(callOptions("context_lookup"), { maxTokens: 16000 });
  assert.deepEqual(callOptions("something_new"), { maxTokens: 16000 });
});

test("the budget table cannot be mutated by a caller", () => {
  assert.throws(() => {
    (CALL_OPTIONS as Record<string, unknown>)["plan"] = { maxTokens: 1 };
  });
});

// ── cache key ────────────────────────────────────────────────────

const BASE = { question: "How is checkout doing?", contextKey: "abc1234567:def0987654" };

test("the same question in the same conversation over the same data replays", () => {
  assert.equal(cacheKey(BASE), cacheKey({ ...BASE }));
  // wording noise is not a different question
  assert.equal(
    cacheKey(BASE),
    cacheKey({ ...BASE, question: "  How   is CHECKOUT doing?  " }),
  );
});

test("a new data version invalidates the replay", () => {
  // contextKey is `${definitionsDigest}:${dataKey}` — a load or an optimizer
  // ALTER moves dataKey, so an answer computed over yesterday's rows is not
  // served for today's.
  assert.notEqual(cacheKey(BASE), cacheKey({ ...BASE, contextKey: "abc1234567:ffffffffff" }));
  assert.notEqual(cacheKey(BASE), cacheKey({ ...BASE, contextKey: "zzzzzzzzzz:def0987654" }));
});

test("two conversations never share an entry", () => {
  // The leak this closes: the key was not conversation-scoped, so a fresh
  // conversation could be served an answer computed for someone else's.
  const a = cacheKey({ ...BASE, convId: "conv-a" });
  const b = cacheKey({ ...BASE, convId: "conv-b" });
  assert.notEqual(a, b);
  assert.notEqual(a, cacheKey(BASE));
});

test("the turns so far and the related text both change the key", () => {
  assert.notEqual(cacheKey(BASE), cacheKey({ ...BASE, historyDigest: "1a2b3c4d5e" }));
  // A replay must never disagree with the related-insights text that produced it.
  assert.notEqual(cacheKey(BASE), cacheKey({ ...BASE, relatedDigest: "9f8e7d6c5b" }));
});

test("a key is a stable 32-char hex digest", () => {
  assert.match(cacheKey(BASE), /^[0-9a-f]{32}$/);
});

// ── sanity gate ──────────────────────────────────────────────────

const task = (over: Partial<TaskResult> = {}): TaskResult => ({
  id: "t1",
  title: "conversion by city",
  sql: "SELECT 1",
  semanticSql: "SELECT 1",
  coreSql: "SELECT 1",
  authoredLimit: null,
  rows: [],
  totalRows: 0,
  digest: null,
  digestNote: "",
  flags: [],
  ...over,
});

test("a rate above 100% is counted as impossible, not as generic noise", () => {
  const { kept, counts } = sanityGate([
    task({ rows: [{ city: "Delhi", applied_rate: 1.2, applied_n: 80 }], totalRows: 1 }),
  ]);
  assert.equal(counts.impossible, 1);
  assert.equal(counts.smallSample, 0);
  assert.equal(counts.dropped, 0);
  assert.equal(kept.length, 1, "an impossible value is flagged, not dropped");
  assert.match(kept[0]!.flags[0]!, /applied_rate=1\.2 looks like a rate above 100%/);
});

test("sample sizes are read by the SUFFIX convention the SQL prompt mandates", () => {
  // The old check matched a `^n|count|total...` PREFIX while every query emits
  // `offer_shown_n` / `applied_denominator`, so this flag essentially never fired.
  // (`purchase_total` below is deliberately ignored now — see the money-column test.)
  const { counts, kept } = sanityGate([
    task({
      rows: [
        { city: "Delhi", offer_shown_n: 12, purchase_total: 4 },
        { city: "Pune", offer_shown_n: 7, purchase_total: 2 },
      ],
      totalRows: 2,
    }),
  ]);
  assert.equal(counts.smallSample, 1);
  assert.match(kept[0]!.flags[0]!, /all sample sizes below 50/);

  // one row at or above 50 and the claim is false
  const big = sanityGate([
    task({ rows: [{ offer_shown_n: 12 }, { offer_shown_n: 900 }], totalRows: 2 }),
  ]);
  assert.equal(big.counts.smallSample, 0);
  assert.deepEqual(big.kept[0]!.flags, []);
});

test("a money column is not mistaken for a sample size", () => {
  // `revenue_total` / `discount_total` / `refund_total` are currency, not counts.
  // Reading a ₹40 discount as a population of 40 put "all sample sizes below 50 —
  // low confidence" in front of the narrator and took a real -0.10 off a correct
  // answer.
  const { counts, kept } = sanityGate([
    task({
      rows: [
        { city: "Delhi", discount_total: 40, revenue_total: 12, refund_total: 3 },
        { city: "Pune", discount_total: 8, revenue_total: 5, refund_total: 1 },
      ],
      totalRows: 2,
    }),
  ]);
  assert.equal(counts.smallSample, 0);
  assert.deepEqual(kept[0]!.flags, []);

  // ...while the real sample-size suffixes still fire
  const real = sanityGate([
    task({ rows: [{ applied_n: 9, offer_denominator: 12, cohort_base: 20 }], totalRows: 1 }),
  ]);
  assert.equal(real.counts.smallSample, 1);
});

test("a task with no usable result is dropped and counted exactly once", () => {
  const { kept, notes, counts } = sanityGate([
    task({ id: "t1", rows: [], totalRows: 0 }),
    task({
      id: "t2",
      rows: [{ blocked: "cannot compute", reason: "no coupon column exists" }],
      totalRows: 1,
    }),
  ]);
  assert.equal(kept.length, 0);
  assert.equal(counts.dropped, 2, "each dropped task counts once, not once per note");
  assert.equal(notes.length, 2);
  assert.match(notes[0]!, /dropped — empty result set/);
  assert.match(notes[1]!, /could not be written — no coupon column exists/);
});

test("a clean result produces no flags and no notes", () => {
  const { kept, notes, counts } = sanityGate([
    task({ rows: [{ city: "Delhi", applied_rate: 0.42, applied_n: 848 }], totalRows: 1 }),
  ]);
  assert.equal(kept.length, 1);
  assert.deepEqual(notes, []);
  assert.deepEqual(counts, { impossible: 0, smallSample: 0, dropped: 0 });
});

test("a count column is not mistaken for a rate above 100%", () => {
  // "share_clicked_applications" is a count; matching "share" inside it once
  // flagged 1,601 as a rate above 100%.
  const { counts } = sanityGate([
    task({ rows: [{ share_clicked_applications: 1601, applied_n: 900 }], totalRows: 1 }),
  ]);
  assert.equal(counts.impossible, 0);
});
