import { test } from "node:test";
import assert from "node:assert/strict";
import { numericColumns, resolveExpectedColumn } from "../../src/agents/verifier.js";

/**
 * Three of four live verification probes came back "inconclusive" because the
 * verifier named an `expected_to_match` column that was not in the result — so
 * the strongest correctness signal we have was thrown away over a spelling.
 *
 * The prompt now hands it the column names, and this resolver is the safety net
 * for when it still misses: match by name, else by the one column holding the
 * same value. "The one" is the load-bearing word — two candidates is a coin
 * flip, and a coin flip dressed as verification is worse than saying nothing.
 */

test("an exact column name resolves against the whole-set profile first", () => {
  const digestRow = { full_applied_rate: 0.327, full_applied_n: 848 };
  const rows = [{ full_applied_rate: 0.9, os: "ios" }];
  const resolved = resolveExpectedColumn("full_applied_rate", 0.327, digestRow, rows);
  assert.deepEqual(resolved, { column: "full_applied_rate", value: 0.327, matchedBy: "name" });
});

test("a name absent from the profile is still found in the sample rows", () => {
  const rows = [{ os: "ios", apply_rate: 0.42, apply_n: 1200 }];
  const resolved = resolveExpectedColumn("apply_rate", 0.42, undefined, rows);
  assert.deepEqual(resolved, { column: "apply_rate", value: 0.42, matchedBy: "name" });
});

test("q3's shape: a name that does not exist resolves by value", () => {
  // The verifier wrote "total_discount"; the profile calls it full_discount_sum.
  const digestRow = { full_discount_sum: 47262, total_rows: 1200 };
  const resolved = resolveExpectedColumn("total_discount", 47262, digestRow, []);
  assert.deepEqual(resolved, { column: "full_discount_sum", value: 47262, matchedBy: "value" });
});

test("a value match tolerates the same 2% the comparison itself allows", () => {
  const digestRow = { full_discount_sum: 47262, total_rows: 1200 };
  // 1% off — the figures agree, so this is the column the verifier meant
  const resolved = resolveExpectedColumn("total_discount", 47_734, digestRow, []);
  assert.equal(resolved.column, "full_discount_sum");
  assert.equal(resolved.matchedBy, "value");
});

test("two columns holding the figure is ambiguous — resolved to nothing", () => {
  const digestRow = { full_paid_sum: 5000, full_charged_sum: 5000 };
  const rows = [{ paid: 1 }, { paid: 2 }];
  const resolved = resolveExpectedColumn("revenue", 5000, digestRow, rows);
  assert.deepEqual(resolved, { column: null, value: null, matchedBy: null });
});

test("a rate is never matched to a count that happens to hold the same number", () => {
  // 0.42 as a `_n` column is a count, not the rate the verifier recomputed
  const rows = [{ applied_n: 0.42, other_n: 7 }];
  const resolved = resolveExpectedColumn("applied_rate", 0.42, undefined, rows);
  assert.equal(resolved.matchedBy, null);
  assert.equal(resolved.column, null);
});

test("a magnitude is never matched to a rate column", () => {
  const digestRow = { full_apply_rate: 0.5, full_apply_n: 3 };
  // the verifier produced 3 — a count, which the rate column must not absorb
  const resolved = resolveExpectedColumn("applications", 3, digestRow, []);
  assert.equal(resolved.column, "full_apply_n");
  assert.equal(resolved.matchedBy, "value");
});

test("a single-row result with exactly one figure needs no name at all", () => {
  const resolved = resolveExpectedColumn("", null, undefined, [{ os: "ios", conversion: 0.61 }]);
  assert.deepEqual(resolved, { column: "conversion", value: 0.61, matchedBy: "value" });
});

test("a single row with two figures is not guessed at", () => {
  const resolved = resolveExpectedColumn("", null, undefined, [{ a_total: 5, b_total: 9 }]);
  assert.deepEqual(resolved, { column: null, value: null, matchedBy: null });
});

test("nothing to compare against resolves to nothing, never to a default", () => {
  assert.deepEqual(resolveExpectedColumn("anything", 42, undefined, []), {
    column: null,
    value: null,
    matchedBy: null,
  });
  assert.deepEqual(resolveExpectedColumn("", null, undefined, []), {
    column: null,
    value: null,
    matchedBy: null,
  });
});

test("the name wins over a value match elsewhere", () => {
  const digestRow = { full_a_sum: 100, full_b_sum: 250 };
  // 250 lives in full_b_sum, but the verifier explicitly named full_a_sum
  const resolved = resolveExpectedColumn("full_a_sum", 250, digestRow, []);
  assert.deepEqual(resolved, { column: "full_a_sum", value: 100, matchedBy: "name" });
});

test("ClickHouse UInt64 strings are figures; nulls and blanks are not", () => {
  const rows = [{ total: "47262", label: "", missing: null, os: "ios" }];
  assert.deepEqual(resolveExpectedColumn("total", 47262, undefined, rows), {
    column: "total",
    value: 47262,
    matchedBy: "name",
  });
  assert.deepEqual(numericColumns(rows[0]), ["total"]);
});

test("numericColumns lists the profile's names before the sample's, without repeats", () => {
  const digestRow = { full_applied_rate: 0.32, full_applied_n: 848 };
  const firstRow = { os: "ios", full_applied_rate: 0.9, apply_n: 12 };
  assert.deepEqual(numericColumns(digestRow, firstRow), [
    "full_applied_rate",
    "full_applied_n",
    "apply_n",
  ]);
  assert.deepEqual(numericColumns(undefined, undefined), []);
});

test("a column that is null in the first row but numeric later is still listed", () => {
  // The verifier is shown the first rows and told which columns it may target.
  // Sampling only row 0 tells it a real column does not exist, it avoids it,
  // and the check falls through to "inconclusive" — the unverified ceiling.
  const rows = [
    { os: "ios", applies: null, revenue: 12 },
    { os: "android", applies: null, revenue: 9 },
    { os: "web", applies: null, revenue: 4 },
    { os: "tv", applies: 317, revenue: 2 },
  ];
  assert.deepEqual(numericColumns(rows[0]), ["revenue"]);
  assert.deepEqual(numericColumns(undefined, ...rows), ["revenue", "applies"]);
});
