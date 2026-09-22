import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findUncitedNumbers,
  hasEvidence,
  numbersIn,
  numericPool,
  type CitableResult,
  sanityGate,
  PlanSchema,
  type TaskResult,
} from "../../src/agents/analytics.js";
import { pickHeadline, type Precision } from "../../src/core/precision.js";

const boundedAt = (column: string, n: number, halfWidthPp: number): Precision => ({
  column,
  kind: "proportion",
  value: 0.5,
  n,
  interval: { lo: 0.5 - halfWidthPp / 200, hi: 0.5 + halfWidthPp / 200, halfWidthPp },
  note: "",
});

/**
 * Four regressions found by running the product, not the unit tests: two of a
 * four-question demo sequence died with a citation error where the honest
 * answer was one sentence, and a verified, fully-powered answer came back
 * "medium" because confidence was charged against the wrong row.
 */

const task = (over: Partial<TaskResult> = {}): TaskResult =>
  ({
    id: "t1",
    title: "t",
    sql: "SELECT 1",
    semanticSql: "SELECT 1",
    coreSql: "SELECT 1",
    authoredLimit: null,
    rows: [],
    totalRows: 0,
    digest: null,
    digestNote: "",
    flags: [],
  }) as unknown as TaskResult;

// ── a rate the narrator had to derive ──────────────────────────────

test("a rate derived from two counts is citable as a percentage", () => {
  // 3 purchases over 13 pay-now clicks. The prompt asks for percentages, so the
  // narrator writes 23.1%; the pool held only the raw 0.2308 and the answer died.
  const results: CitableResult[] = [
    { rows: [{ application_n: 13 }], totalRows: 1, digest: null },
    { rows: [{ purchase_n: 3 }], totalRows: 1, digest: null },
  ] as unknown as CitableResult[];
  const pool = numericPool(results, 24);
  assert.deepEqual(findUncitedNumbers(["Wallet users convert at 23.1%."], pool), []);
  // the raw fraction still cites, and an invented figure still does not
  assert.deepEqual(findUncitedNumbers(["A rate of 0.231."], pool), []);
  assert.deepEqual(findUncitedNumbers(["Wallet users convert at 61.4%."], pool), ["61.4"]);
});

test("a percentage-point gap between two fetched rates is citable", () => {
  // No new pairing needed: numericPool already holds 85.8 and 47.9 beside the
  // fractions, so the gap is an ordinary derived difference. Asserted so a
  // future tightening of the pool cannot quietly break it.
  const results: CitableResult[] = [
    { rows: [{ express_rate: 0.858, standard_rate: 0.479 }], totalRows: 1, digest: null },
  ] as unknown as CitableResult[];
  const pool = numericPool(results, 24);
  assert.deepEqual(findUncitedNumbers(["Express leads by 37.9pp."], pool), []);
  assert.deepEqual(findUncitedNumbers(["Express leads by 64.2pp."], pool), ["64.2"]);
});

test("scaling derived rates does not weaken the guard on non-count pairs", () => {
  // The first cut scaled every ratio in [-1,1] and made the pool permissive
  // enough to admit figures the check exists to catch.
  const results: CitableResult[] = [
    { rows: [{ a_rate: 0.31, b_rate: 0.62 }], totalRows: 1, digest: null },
  ] as unknown as CitableResult[];
  const pool = numericPool(results, 24);
  assert.deepEqual(findUncitedNumbers(["a figure of 88.4"], pool), ["88.4"]);
});

// ── the asker's own numbers ────────────────────────────────────────

test("a window the question named is not an uncited figure", () => {
  const pool = [0.5];
  assert.deepEqual(findUncitedNumbers(["Over the last 30 days, conversion held."], pool), ["30"]);
  assert.deepEqual(
    findUncitedNumbers(["Over the last 30 days, conversion held."], pool, [], numbersIn("last 30 days")),
    [],
  );
});

test("quoting the question does not license arithmetic on it", () => {
  // 30 is allowed because it was asked; 30/7 is not — askedNumbers are not pairable
  const uncited = findUncitedNumbers(["4.29 weeks in the last 30 days"], [0.5], [], [30, 7]);
  assert.deepEqual(uncited, ["4.29"]);
});

test("numbersIn reads thousands separators and decimals", () => {
  assert.deepEqual(numbersIn("14,026 clicks over 30 days at 47.9%"), [14026, 30, 47.9]);
  assert.deepEqual(numbersIn("no digits here"), []);
});

// ── an empty window is an answer, not a failure ────────────────────

test("zero rows is no evidence", () => {
  assert.equal(hasEvidence([]), false);
  assert.equal(hasEvidence([task()]), false);
});

test("a COUNT over an empty set is no evidence", () => {
  const empty = task();
  empty.rows = [{ pay_now_n: 0, purchase_n: 0, conversion_rate: null }];
  empty.totalRows = 1;
  assert.equal(hasEvidence([empty]), false);
});

test("a real zero against a real denominator IS evidence", () => {
  // 0% of 5,000 is a finding; it must still reach the narrator
  const real = task();
  real.rows = [{ pay_now_n: 5000, purchase_n: 0, conversion_rate: 0 }];
  real.totalRows = 1;
  assert.equal(hasEvidence([real]), true);
});

test("a non-numeric cell is evidence even when every number is zero", () => {
  const labelled = task();
  labelled.rows = [{ country: "SG", n: 0 }];
  labelled.totalRows = 1;
  assert.equal(hasEvidence([labelled]), true);
});

test("one empty task among several does not hide the others", () => {
  const empty = task();
  const full = task();
  full.rows = [{ n: 42 }];
  full.totalRows = 1;
  assert.equal(hasEvidence([empty, full]), true);
});

// ── the headline is the best-supported row of its column ───────────

test("pickHeadline takes the population row, not the widest row of the same column", () => {
  // One question, three tasks: a total and two breakdowns, all emitting
  // `conversion_rate`. The headline states the total.
  const rows = [
    boundedAt("conversion_rate", 14026, 0.83),
    boundedAt("conversion_rate", 198, 6.81),
    boundedAt("conversion_rate", 41, 15.2),
  ];
  assert.equal(pickHeadline(rows, ["conversion_rate"], null)?.n, 14026);
  assert.equal(pickHeadline(rows, [], "conversion_rate")?.n, 14026);
  // order cannot change it
  assert.equal(pickHeadline([...rows].reverse(), [], "conversion_rate")?.n, 14026);
});

test("conservatism across DIFFERENT metrics is unchanged", () => {
  // Within a column the best-supported row wins; between columns the widest
  // still does, so a shaky second metric still drags the answer down.
  const rows = [boundedAt("a_rate", 500, 2), boundedAt("b_rate", 300, 6)];
  assert.equal(pickHeadline(rows, ["a_rate", "b_rate"], null)?.column, "b_rate");
});

// ── one impossible value is one finding ────────────────────────────

const digestOver = (columns: string[], statsRow: Record<string, unknown> = {}) =>
  ({
    totalRows: 1,
    sql: "SELECT 1",
    statsRow,
    emissions: columns.map((c) => ({ sql: "", alias: `${c}_gt1_n`, column: c, stat: "gt1_n" })),
    columnStats: columns.map((c) => ({ column: c, kind: "rate", stats: [] })),
    extremes: null,
  }) as unknown as TaskResult["digest"];

test("a digest does not make an impossible rate count twice", () => {
  const withDigest = task();
  withDigest.rows = [{ applied_rate: 1.2 }];
  withDigest.totalRows = 1;
  // the digest profiled that very column, and says so over the whole set
  withDigest.digest = digestOver(["applied_rate"], { applied_rate_gt1_n: 1 });
  const { counts } = sanityGate([withDigest]);
  assert.equal(counts.impossible, 1);
});

test("a column the digest did not profile is still checked row-side", () => {
  // The digest profiles only the first few columns of each kind. Suppressing the
  // row check for ALL columns once a digest existed left the rest unexamined —
  // a rate above 100% in the fifth rate column was reported by neither side.
  const spilled = task();
  spilled.rows = [{ a_rate: 0.4, e_rate: 1.2 }];
  spilled.totalRows = 1;
  spilled.digest = digestOver(["a_rate"], { a_rate_gt1_n: 0 });
  const { counts, kept } = sanityGate([spilled]);
  assert.equal(counts.impossible, 1);
  assert.ok(kept[0]?.flags.some((f) => f.includes("e_rate")), kept[0]?.flags.join("; ") ?? "no flags");
});

test("a digest that profiled nothing leaves the row check in charge", () => {
  const empty = task();
  empty.rows = [{ applied_rate: 1.2 }];
  empty.totalRows = 1;
  empty.digest = digestOver([]);
  assert.equal(sanityGate([empty]).counts.impossible, 1);
});

test("without a digest the per-row check still fires", () => {
  const plain = task();
  plain.rows = [{ applied_rate: 1.2 }];
  plain.totalRows = 1;
  assert.equal(sanityGate([plain]).counts.impossible, 1);
});

// ── the vague-question lever survives a malformed plan ─────────────

test("assumptions sent as a string are split, not discarded", () => {
  const plan = PlanSchema.parse({
    approach: "a",
    tasks: [],
    assumptions: "last 90 days; all platforms",
  });
  assert.deepEqual(plan.assumptions, ["last 90 days", "all platforms"]);
});

test("assumptions in a shape we cannot read still fall back to none", () => {
  const plan = PlanSchema.parse({ approach: "a", tasks: [], assumptions: { a: 1 } });
  assert.deepEqual(plan.assumptions, []);
});

test("a well-formed array is untouched", () => {
  const plan = PlanSchema.parse({ approach: "a", tasks: [], assumptions: ["  x  ", ""] });
  assert.deepEqual(plan.assumptions, ["x"]);
});
