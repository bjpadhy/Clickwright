import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveConfidence,
  headlinePenalty,
  namedMetrics,
  pickHeadline,
  type ConfidenceInput,
  type MetricKind,
  type Precision,
} from "../../src/core/precision.js";

/**
 * Confidence is a SUM of named signals, so every test here checks two things at
 * once: the number, and that the breakdown explains it (`1 + Σdelta === score`).
 *
 * The five fixtures are the real traces the redesign was measured against —
 * their expected scores are the contract, and changing a weight without changing
 * these numbers means the weight did not do what it claimed.
 */

/* ── fixture builders ─────────────────────────────────────────────── */

function bounded(column: string, n: number, halfWidthPp: number, value = 0.5): Precision {
  const half = halfWidthPp / 100;
  return {
    column,
    kind: "proportion",
    value,
    n,
    interval: { lo: Math.max(0, value - half), hi: Math.min(1, value + half), halfWidthPp },
    note: `Wilson 95% on n=${n}`,
  };
}

function unbounded(column: string, kind: MetricKind): Precision {
  return { column, kind, value: 1, n: null, interval: null, note: `a ${kind} cannot be bounded here` };
}

function input(over: Partial<ConfidenceInput> = {}): ConfidenceInput {
  return {
    precisions: [],
    headlineColumns: [],
    verifiedColumn: null,
    verification: null,
    impossibleFlags: 0,
    smallSampleFlags: 0,
    droppedTasks: 0,
    plannedTasks: 0,
    citationRetries: 0,
    assumptions: [],
    namedMetrics: [],
    ...over,
  };
}

function verification(
  agreed: boolean | null,
  relativeDelta: number | null = null,
  over: Partial<NonNullable<ConfidenceInput["verification"]>> = {},
): NonNullable<ConfidenceInput["verification"]> {
  return {
    agreed,
    relativeDelta,
    definitionOk: true,
    concern: "",
    note: "an independently written query reproduced full_applied_rate",
    ...over,
  };
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** The invariant the UI's waterfall depends on. */
function assertSumsToScore(result: ReturnType<typeof deriveConfidence>): void {
  const total = round2(result.signals.reduce((sum, s) => sum + s.delta, 1));
  assert.equal(total, result.score, `1 + Σdelta (${total}) must equal score (${result.score})`);
}

/* ── the five trace fixtures ──────────────────────────────────────── */

/** spec-06 q1: the answer the OLD rule called "low 0.50" because one tail row
 * had n=2, while its headline figure (n=848) had been reproduced exactly. */
const SPEC06_Q1 = input({
  precisions: [
    bounded("full_applied_rate", 848, 3.1),
    bounded("applied_rate", 2, 40.5),
    bounded("apply_rate", 14, 24),
    bounded("segment_rate", 31, 17),
  ],
  headlineColumns: ["full_applied_rate"],
  verifiedColumn: "full_applied_rate",
  verification: verification(true, 0),
  plannedTasks: 3,
});

test("spec-06 q1 — a verified population figure is high, not low", () => {
  const result = deriveConfidence(SPEC06_Q1);
  assert.equal(result.value, "high");
  assert.ok(Math.abs(result.score - 0.79) < 0.011, `expected ≈0.79, got ${result.score}`);
  assertSumsToScore(result);
  // the headline the reader acts on is named; the n=2 tail row is not what the
  // note leads with — that inversion was the whole bug
  assert.match(result.note, /n=848/);
  assert.doesNotMatch(result.note, /n=2\b/);
  assert.match(result.note, /small segments/);
});

/** probe-1 with only extreme rows bounded: nothing is a population estimate. */
const PROBE1_TAILS = input({
  precisions: [bounded("applied_rate", 2, 40.5), bounded("apply_rate", 5, 30), bounded("seg_rate", 8, 25)],
  plannedTasks: 2,
});

test("probe-1 tail-only — a result of nothing but small segments floors out", () => {
  const result = deriveConfidence(PROBE1_TAILS);
  assert.equal(result.value, "low");
  assert.ok(result.score <= 0.1, `expected ≤0.10, got ${result.score}`);
  assert.equal(result.score, 0.05);
  assertSumsToScore(result);
});

/** The same probe once the task also emits a whole-population rate. */
const PROBE1_POPULATION = input({
  precisions: [bounded("full_apply_rate", 400, 4.5), bounded("applied_rate", 2, 40.5)],
  headlineColumns: ["full_apply_rate"],
  plannedTasks: 2,
});

test("probe-1 with a population headline ±4.5pp — medium 0.50", () => {
  const result = deriveConfidence(PROBE1_POPULATION);
  assert.equal(result.value, "medium");
  assert.ok(Math.abs(result.score - 0.5) < 0.011, `expected ≈0.50, got ${result.score}`);
  assertSumsToScore(result);
  assert.match(result.note, /not independently verified/);
});

/** probe-2: two independently written queries disagreed by 5.3%. */
const PROBE2_DISAGREED = input({
  precisions: [bounded("full_conv_rate", 1200, 2.0)],
  headlineColumns: ["full_conv_rate"],
  verifiedColumn: "full_conv_rate",
  verification: verification(false, 0.053, {
    note: "an independently written query got 0.31 where the analysis reported 0.327",
  }),
  plannedTasks: 1,
});

test("probe-2 verified-false — low 0.38, and the note carries the gap", () => {
  const result = deriveConfidence(PROBE2_DISAGREED);
  assert.equal(result.value, "low");
  assert.ok(Math.abs(result.score - 0.38) < 0.011, `expected ≈0.38, got ${result.score}`);
  assertSumsToScore(result);
  assert.match(result.note, /5\.3%/);
});

/** spec-06 q3: sums and means only — the OLD rule scored this "high 1.00". */
const SPEC06_Q3 = input({
  precisions: [unbounded("avg_discount", "mean"), unbounded("discount_per_order", "ratio")],
  plannedTasks: 2,
});

test("spec-06 q3 — nothing bounded is medium 0.60, never high 1.00", () => {
  const result = deriveConfidence(SPEC06_Q3);
  assert.equal(result.value, "medium");
  assert.ok(Math.abs(result.score - 0.6) < 0.011, `expected ≈0.60, got ${result.score}`);
  assertSumsToScore(result);
  assert.match(result.note, /not independently verified/);
  assert.match(result.note, /no figure carries an interval/);
});

/* ── determinism ──────────────────────────────────────────────────── */

test("the same input twice produces the identical result", () => {
  for (const fixture of [SPEC06_Q1, PROBE1_TAILS, PROBE1_POPULATION, PROBE2_DISAGREED, SPEC06_Q3]) {
    assert.deepEqual(deriveConfidence(fixture), deriveConfidence(fixture));
  }
});

test("the order of `precisions` does not change the score", () => {
  const forwards = deriveConfidence(SPEC06_Q1);
  const shuffles = [
    [3, 1, 0, 2],
    [2, 0, 3, 1],
    [1, 3, 2, 0],
  ];
  for (const order of shuffles) {
    const shuffled = deriveConfidence({
      ...SPEC06_Q1,
      precisions: order.map((i) => SPEC06_Q1.precisions[i]!),
    });
    assert.deepEqual(shuffled, forwards);
  }
});

test("every signal list sums with 1 to the score", () => {
  const cases = [
    SPEC06_Q1,
    PROBE1_TAILS,
    PROBE1_POPULATION,
    PROBE2_DISAGREED,
    SPEC06_Q3,
    input({ precisions: [bounded("r", 900, 0.4)], verification: verification(true), namedMetrics: ["x"] }),
    input({ assumptions: ["a", "b", "c", "d", "e", "f"], citationRetries: 4, droppedTasks: 5, impossibleFlags: 3 }),
  ];
  for (const c of cases) assertSumsToScore(deriveConfidence(c));
});

/* ── bands and ceilings ───────────────────────────────────────────── */

test("the level is a pure function of the score, with no overlapping bands", () => {
  const grid: ConfidenceInput[] = [];
  for (const agreed of [true, false, null] as const) {
    for (const assumptions of [0, 1, 3, 6]) {
      for (const hw of [0, 3.1, 7, 24]) {
        grid.push(
          input({
            precisions: [bounded("full_rate", 500, hw)],
            headlineColumns: ["full_rate"],
            verification: verification(agreed),
            assumptions: Array.from({ length: assumptions }, (_, i) => `assumption ${i}`),
          }),
        );
      }
    }
  }
  for (const c of grid) {
    const { score, value } = deriveConfidence(c);
    const expected = score >= 0.75 ? "high" : score >= 0.45 ? "medium" : "low";
    assert.equal(value, expected, `score ${score} must be ${expected}`);
    assert.ok(score >= 0.05 && score <= 1, `score ${score} out of range`);
  }
});

test("0.75 is high and 0.45 is medium — the bands are inclusive at the bottom", () => {
  // clean and verified, minus the assumptions cap
  const atHigh = deriveConfidence(
    input({
      precisions: [bounded("full_rate", 1000, 0)],
      headlineColumns: ["full_rate"],
      verification: verification(true),
      assumptions: ["a", "b", "c", "d"],
    }),
  );
  assert.equal(atHigh.score, 0.75);
  assert.equal(atHigh.value, "high");

  const atMedium = deriveConfidence(
    input({
      precisions: [bounded("full_rate", 1000, 0)],
      headlineColumns: ["full_rate"],
      verification: verification(true, 0, { definitionOk: false, concern: "wrong denominator" }),
      assumptions: ["a", "b", "c", "d"],
      citationRetries: 2,
    }),
  );
  assert.equal(atMedium.score, 0.45);
  assert.equal(atMedium.value, "medium");

  // one hundredth lower is low — nothing sits in two bands
  const belowMedium = deriveConfidence(
    input({
      precisions: [bounded("full_rate", 1000, 0.33)],
      headlineColumns: ["full_rate"],
      verification: verification(true, 0, { definitionOk: false, concern: "wrong denominator" }),
      assumptions: ["a", "b", "c", "d"],
      citationRetries: 2,
    }),
  );
  assert.equal(belowMedium.score, 0.44);
  assert.equal(belowMedium.value, "low");
});

test("an unverified answer can never be high, however clean the rest is", () => {
  for (const verdict of [null, undefined] as const) {
    const result = deriveConfidence(
      input({
        precisions: [bounded("full_rate", 50_000, 0)],
        headlineColumns: ["full_rate"],
        verification: verdict === null ? verification(null) : null,
        namedMetrics: ["standard_checkout_conversion_rate"],
      }),
    );
    assert.ok(result.score <= 0.7, `expected ≤0.70, got ${result.score}`);
    assert.notEqual(result.value, "high");
  }
});

test("an answer with nothing bounded can never exceed 0.60", () => {
  const result = deriveConfidence(
    input({ precisions: [unbounded("total_revenue", "mean")], verification: verification(true) }),
  );
  assert.ok(result.score <= 0.6, `expected ≤0.60, got ${result.score}`);
});

test("a failed verification can never reach medium", () => {
  const result = deriveConfidence(
    input({
      precisions: [bounded("full_rate", 50_000, 0)],
      headlineColumns: ["full_rate"],
      verifiedColumn: "full_rate",
      verification: verification(false, 0.4),
      namedMetrics: ["standard_checkout_conversion_rate"],
    }),
  );
  assert.ok(result.score < 0.45, `expected <0.45, got ${result.score}`);
  assert.equal(result.value, "low");
});

/* ── individual signals ───────────────────────────────────────────── */

test("the named-metric bonus never lifts a score above what was deducted", () => {
  const clean = input({
    precisions: [bounded("full_rate", 1000, 0)],
    headlineColumns: ["full_rate"],
    verification: verification(true),
  });
  // nothing was deducted, so the bonus is 0 and a perfect answer stays at 1.00
  const perfect = deriveConfidence({ ...clean, namedMetrics: ["standard_checkout_conversion_rate"] });
  assert.equal(perfect.score, 1);
  assertSumsToScore(perfect);

  // with a deduction to offset, the bonus is worth its full 0.05
  const withAssumption = deriveConfidence({ ...clean, assumptions: ["last 30 days"] });
  const withBoth = deriveConfidence({
    ...clean,
    assumptions: ["last 30 days"],
    namedMetrics: ["standard_checkout_conversion_rate"],
  });
  assert.equal(round2(withBoth.score - withAssumption.score), 0.05);
  assert.match(withBoth.note, /standard_checkout_conversion_rate/);
});

test("assumptions are the lever a vague question pulls, capped at 0.25", () => {
  const base = { precisions: [], verification: verification(null) };
  const one = deriveConfidence(input({ ...base, assumptions: ["last 90 days"] }));
  const four = deriveConfidence(
    input({ ...base, assumptions: ["metric", "denominator", "window", "segment"] }),
  );
  const six = deriveConfidence(
    input({ ...base, assumptions: ["a", "b", "c", "d", "e", "f"] }),
  );
  assert.equal(round2(four.score - one.score), -0.17); // 0.32 capped to 0.25, minus 0.08
  assert.equal(six.score, four.score, "the cap holds past four assumptions");
  assert.match(one.note, /assumed: last 90 days/);
});

test("deductions have caps, so one bad signal cannot swamp the rest", () => {
  const many = deriveConfidence(
    input({ precisions: [], verification: verification(null), impossibleFlags: 9, citationRetries: 9, droppedTasks: 9, plannedTasks: 9 }),
  );
  const byName = new Map(many.signals.map((s) => [s.name, s.delta]));
  assert.equal(byName.get("impossible_values"), -0.2);
  assert.equal(byName.get("citation_retries"), -0.2);
  assert.equal(byName.get("dropped_tasks"), -0.21);
});

test("a concern the auditor raised is surfaced even when the definition held", () => {
  const withConcern = deriveConfidence(
    input({
      precisions: [bounded("full_rate", 800, 1)],
      headlineColumns: ["full_rate"],
      verification: verification(true, 0, { concern: "the join could fan rows out" }),
    }),
  );
  const signal = withConcern.signals.find((s) => s.name === "definition_concern");
  assert.equal(signal?.delta, 0, "an agreed definition costs nothing");
  assert.match(withConcern.note, /the join could fan rows out/);

  const withBadDefinition = deriveConfidence(
    input({
      precisions: [bounded("full_rate", 800, 1)],
      headlineColumns: ["full_rate"],
      verification: verification(true, 0, { definitionOk: false, concern: "used all applications, not pay_now_clicked" }),
    }),
  );
  assert.equal(withBadDefinition.signals.find((s) => s.name === "definition_concern")?.delta, -0.1);
});

test("a small-sample flag only counts when nothing could be bounded", () => {
  const unboundedFlagged = deriveConfidence(
    input({ precisions: [unbounded("avg_x", "mean")], smallSampleFlags: 1, verification: verification(true) }),
  );
  assert.ok(unboundedFlagged.signals.some((s) => s.name === "small_sample_flag"));

  const boundedFlagged = deriveConfidence(
    input({
      precisions: [bounded("full_rate", 900, 1)],
      headlineColumns: ["full_rate"],
      smallSampleFlags: 1,
      verification: verification(true),
    }),
  );
  assert.ok(
    !boundedFlagged.signals.some((s) => s.name === "small_sample_flag"),
    "the measured interval already says this, more precisely",
  );
});

test("rates that shipped no denominator are called out once", () => {
  const result = deriveConfidence(
    input({
      precisions: [unbounded("apply_rate", "proportion"), unbounded("convert_rate", "proportion")],
      verification: verification(true),
    }),
  );
  const signal = result.signals.find((s) => s.name === "rates_without_denominator");
  assert.equal(signal?.delta, -0.1);
  assert.match(signal!.detail, /2 rates ship no denominator/);
});

/* ── headlinePenalty ──────────────────────────────────────────────── */

test("headlinePenalty is continuous, monotonic and bounded at 0.65", () => {
  assert.equal(headlinePenalty(0), 0);
  assert.ok(Math.abs(headlinePenalty(4) - 0.12) < 1e-9);
  assert.ok(Math.abs(headlinePenalty(10) - 0.57) < 1e-9);
  assert.ok(Math.abs(headlinePenalty(24) - 0.65) < 1e-9);
  // the raw penalty is not rounded — `deriveConfidence` rounds it into the score
  assert.ok(Math.abs(headlinePenalty(1000) - 0.65) < 1e-9);
  // no jump at either join
  assert.ok(Math.abs(headlinePenalty(4.001) - headlinePenalty(3.999)) < 0.001);
  assert.ok(Math.abs(headlinePenalty(10.001) - headlinePenalty(9.999)) < 0.001);

  let previous = -1;
  for (let hw = 0; hw <= 40; hw += 0.5) {
    const penalty = headlinePenalty(hw);
    assert.ok(penalty >= previous, `penalty must not fall at ±${hw}pp`);
    previous = penalty;
  }
  // a negative or NaN half-width costs nothing rather than throwing
  assert.equal(headlinePenalty(-3), 0);
  assert.equal(headlinePenalty(Number.NaN), 0);
});

/* ── pickHeadline ─────────────────────────────────────────────────── */

test("pickHeadline prefers the verified column over everything", () => {
  const precisions = [bounded("full_wide_rate", 100, 20), bounded("checked_rate", 900, 1)];
  const picked = pickHeadline(precisions, ["full_wide_rate"], "checked_rate");
  assert.equal(picked?.column, "checked_rate");
});

test("pickHeadline falls to the widest population column, then to the largest n", () => {
  const precisions = [
    bounded("full_a_rate", 500, 2),
    bounded("full_b_rate", 300, 6),
    bounded("segment_rate", 90_000, 0.1),
  ];
  assert.equal(pickHeadline(precisions, ["full_a_rate", "full_b_rate"], null)?.column, "full_b_rate");
  // no population columns declared ⇒ the best-supported bounded figure
  assert.equal(pickHeadline(precisions, [], null)?.column, "segment_rate");
});

test("pickHeadline breaks ties on the column name, so order cannot change it", () => {
  const precisions = [bounded("b_rate", 100, 5), bounded("a_rate", 100, 5)];
  assert.equal(pickHeadline(precisions, [], null)?.column, "a_rate");
  assert.equal(pickHeadline([...precisions].reverse(), [], null)?.column, "a_rate");
  assert.equal(pickHeadline(precisions, ["a_rate", "b_rate"], null)?.column, "a_rate");
});

test("pickHeadline returns null when nothing carries an interval", () => {
  assert.equal(pickHeadline([unbounded("avg_x", "mean")], ["avg_x"], "avg_x"), null);
  assert.equal(pickHeadline([], [], null), null);
});

test("a verified column that was never bounded does not become the headline", () => {
  const precisions = [unbounded("total_discount", "ratio"), bounded("full_rate", 700, 2)];
  assert.equal(pickHeadline(precisions, ["full_rate"], "total_discount")?.column, "full_rate");
});

/* ── namedMetrics ─────────────────────────────────────────────────── */

/** The stored `metric:*` entities of the seeded context store. */
const STORED = [
  "metric:conversion_rate",
  "metric:express_adoption_rate",
  "metric:express_checkout_conversion_rate",
  "metric:express_payment_completion_rate",
  "metric:funnel_conversion",
  "metric:passport_capture_pass_rate",
  "metric:standard_checkout_conversion_rate",
  "overview:checkout",
  "table:pay_now_clicked",
];

test("namedMetrics finds the metric a question pins, and only the specific one", () => {
  assert.deepEqual(namedMetrics("What is the standard checkout conversion rate?", STORED), [
    "standard_checkout_conversion_rate",
  ]);
  assert.deepEqual(namedMetrics("How does express adoption rate look on iOS?", STORED), [
    "express_adoption_rate",
  ]);
  assert.deepEqual(namedMetrics("Break the funnel conversion down by country", STORED), [
    "funnel_conversion",
  ]);
  // the id written out literally, which no whole-word match would catch
  assert.deepEqual(namedMetrics("plot metric:passport_capture_pass_rate weekly", STORED), [
    "passport_capture_pass_rate",
  ]);
});

test("namedMetrics finds more than one when the question names more than one", () => {
  assert.deepEqual(
    namedMetrics("Compare express adoption rate against passport capture pass rate", STORED),
    ["express_adoption_rate", "passport_capture_pass_rate"],
  );
});

test("namedMetrics refuses a vague question — the bonus has to be earned", () => {
  assert.deepEqual(namedMetrics("How is checkout doing?", STORED), []);
  assert.deepEqual(namedMetrics("Where are we losing conversions?", STORED), []);
  assert.deepEqual(namedMetrics("What's our rate?", STORED), []);
  assert.deepEqual(namedMetrics("", STORED), []);
  // whole words only: "conversions" is not "conversion"
  assert.deepEqual(namedMetrics("conversions rate", STORED), []);
  // non-metric entities are never matched
  assert.deepEqual(namedMetrics("show me the checkout overview", STORED), []);
});

test("namedMetrics is sorted and deduplicated, so the note never changes wording", () => {
  const question = "passport capture pass rate vs express adoption rate";
  const forwards = namedMetrics(question, STORED);
  const backwards = namedMetrics(question, [...STORED].reverse());
  assert.deepEqual(forwards, backwards);
  assert.deepEqual(forwards, [...forwards].sort());
  assert.deepEqual(namedMetrics(question, [...STORED, "metric:express_adoption_rate"]), forwards);
});
