import { test } from "node:test";
import assert from "node:assert/strict";
import { unstatedAssumptions } from "../../src/core/precision.js";

/**
 * Each assumption costs 0.08. That is only meaningful if pinning the thing down
 * removes the charge — otherwise a fully specified question scores below a vague
 * one, which is what the live walkthrough showed.
 */

const Q3 =
  "Standard checkout conversion rate — payments confirmed over pay_now_clicked applications, between 2026-01-01 and 2026-07-01, all platforms";

test("an assumption the question spelled out is not charged", () => {
  const kept = unstatedAssumptions(Q3, [
    "time window = 2026-01-01 to 2026-07-01",
    "denominator = pay_now_clicked applications",
    "all platforms included",
  ]);
  assert.deepEqual(kept, []);
});

test("a real assumption survives alongside them", () => {
  const kept = unstatedAssumptions(Q3, [
    "time window = 2026-01-01 to 2026-07-01",
    "apply convention:data_hygiene (duplicate_id IS NULL, is_back_filled != 1)",
  ]);
  assert.deepEqual(kept, ["apply convention:data_hygiene (duplicate_id IS NULL, is_back_filled != 1)"]);
});

test("a vague question keeps every assumption", () => {
  const assumptions = [
    "last 30 days",
    "denominator = pay_now_clicked applications",
    "all platforms",
  ];
  assert.deepEqual(unstatedAssumptions("How is checkout doing?", assumptions), assumptions);
});

test("a value the question expressed differently is still charged", () => {
  // "SG" is not "Singapore"; the check cannot prove equivalence, so it keeps it.
  const kept = unstatedAssumptions("wallet users in Singapore on iOS", [
    "segment: geoip_country_code = 'SG'",
  ]);
  assert.deepEqual(kept, ["segment: geoip_country_code = 'SG'"]);
});

test("a partial match is not a match", () => {
  // The window is named but the denominator is not — only the window drops.
  const kept = unstatedAssumptions("conversion between 2026-01-01 and 2026-07-01", [
    "time window = 2026-01-01 to 2026-07-01",
    "denominator = express_checkout_shown",
  ]);
  assert.deepEqual(kept, ["denominator = express_checkout_shown"]);
});

test("an assumption with nothing checkable is kept", () => {
  assert.deepEqual(unstatedAssumptions("anything", ["= 42"]), ["= 42"]);
});

test("it is order-preserving and pure", () => {
  const input = ["b thing", "a thing"];
  const once = unstatedAssumptions("q", input);
  assert.deepEqual(once, unstatedAssumptions("q", input));
  assert.deepEqual(once, input);
});

// ── a named metric pins its own denominator and filters ────────────

const CONVERSION_DEF =
  "**Standard checkout conversion rate** = `uniqExact(application_id)` in `purchase_completed` ÷ " +
  "`uniqExact(application_id)` in `pay_now_clicked`, both with `convention:data_hygiene` filters " +
  "applied (`duplicate_id IS NULL` and `is_back_filled != 1`).";

test("a metric's own definition pins its denominator and filters", () => {
  const kept = unstatedAssumptions(
    "What is the standard checkout conversion rate?",
    [
      "denominator = pay_now_clicked applications",
      "apply data hygiene filters (duplicate_id IS NULL, is_back_filled != 1)",
      "all time",
    ],
    [CONVERSION_DEF],
  );
  // the window is genuinely open; the other two are fixed by the definition
  assert.deepEqual(kept, ["all time"]);
});

test("without the definition the same assumptions are still charged", () => {
  const assumptions = ["denominator = pay_now_clicked applications", "all time"];
  assert.deepEqual(
    unstatedAssumptions("What is the standard checkout conversion rate?", assumptions),
    assumptions,
  );
});

test("an unrelated definition does not excuse an assumption", () => {
  const kept = unstatedAssumptions(
    "What is the standard checkout conversion rate?",
    ["segment: wallet users only"],
    [CONVERSION_DEF],
  );
  assert.deepEqual(kept, ["segment: wallet users only"]);
});
