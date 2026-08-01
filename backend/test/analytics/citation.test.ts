import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectDateLiterals,
  findUncitedNumbers,
  numericPool,
  type CitableResult,
} from "../../src/agents/analytics.js";
import { buildDigestSql, shapeDigest, type ResultDigest } from "../../src/core/result-digest.js";
import { precisionForRow } from "../../src/core/precision.js";

/**
 * The citation contract: a number in the narration must exist in a query result.
 * Widening what the narrator can see means widening this pool in lockstep — a
 * figure it is shown but cannot cite fails the answer after three retries.
 */

const COLUMNS = [
  { name: "city", kind: "categorical" as const },
  { name: "conversion_rate", kind: "rate" as const },
  { name: "conversion_n", kind: "count" as const },
  { name: "day", kind: "temporal" as const },
];

function digestFor(statsRow: Record<string, unknown>, extremes?: ResultDigest["extremes"]): ResultDigest {
  const plan = buildDigestSql("SELECT 1", COLUMNS);
  const { population, columnStats } = shapeDigest(statsRow, plan.emissions, COLUMNS);
  return {
    totalRows: Number(statsRow["total_rows"]),
    statsRow,
    population,
    columnStats,
    emissions: plan.emissions,
    sql: plan.sql,
    extremes: extremes ?? null,
    typesFromSample: false,
  };
}

const LARGE: CitableResult = {
  rows: Array.from({ length: 1000 }, (_, i) => ({
    city: `city_${i}`,
    conversion_rate: 0.5,
    conversion_n: 100,
    day: "2025-03-01",
  })),
  totalRows: 52340,
  digest: digestFor(
    {
      total_rows: 52340,
      full_conversion_rate: 0.0712,
      full_conversion_n: 48212,
      conversion_rate_max: 0.94,
      day_min: "2025-03-01",
      day_max: "2025-06-30",
      city_distinct_approx: 412,
    },
    {
      metric: "conversion_rate",
      top: [{ city: "Delhi", conversion_rate: 0.94, conversion_n: 120 }],
      bottom: [{ city: "Kochi", conversion_rate: 0.01, conversion_n: 3 }],
      topSql: "",
      bottomSql: "",
    },
  ),
};

test("whole-set figures the narrator is shown are citable", () => {
  const pool = numericPool([LARGE], 24);
  // Every one of these appears in the profile block the narrator reads.
  assert.deepEqual(findUncitedNumbers(["52340 rows, 7.12% overall, peak 0.94, about 412 cities"], pool), []);
});

test("extreme rows are citable, so the worst segment can be named", () => {
  const pool = numericPool([LARGE], 24);
  assert.deepEqual(findUncitedNumbers(["Kochi converts at 1% on just 3 sessions"], pool), []);
});

test("the true row count is citable even though far more rows exist than were fetched", () => {
  const pool = numericPool([LARGE], 24);
  assert.deepEqual(findUncitedNumbers(["across all 52340 city-days"], pool), []);
});

test("a number the results never contained is still rejected", () => {
  const pool = numericPool([LARGE], 24);
  assert.deepEqual(findUncitedNumbers(["revenue rose to 88431"], pool), ["88431"]);
});

test("shown rows enter the pool ahead of digest figures", () => {
  // findUncitedNumbers pairs only the leading distinct values when deriving deltas.
  // A task's digest crowding out another task's visible rows would make legitimate
  // segment-to-segment comparisons uncitable.
  const other: CitableResult = {
    rows: [{ city: "Pune", conversion_rate: 0.31, conversion_n: 900 }],
    totalRows: 1,
    digest: null,
  };
  const pool = numericPool([LARGE, other], 24);
  const firstDigestValue = pool.indexOf(52340 * 0 + 0.0712);
  const shownValue = pool.indexOf(0.31);
  assert.ok(shownValue >= 0 && firstDigestValue >= 0);
  assert.ok(shownValue < firstDigestValue, "visible rows must be pooled before digest figures");
});

// ── dates ────────────────────────────────────────────────────────

test("a date quoted from the results is a citation, not three uncited numbers", () => {
  // The latent bug this fixes: '2025-03-15' tokenises to 2025, -03 and -15. The year
  // and -03 are ignored, but -15 was reported uncited, so a narrator quoting a date
  // straight out of its own results failed the check.
  const pool = numericPool([LARGE], 24);
  const dates = collectDateLiterals([LARGE], 24);
  assert.ok(dates.includes("2025-06-30"), "digest date ranges must reach the date pool");

  assert.deepEqual(findUncitedNumbers(["covers 2025-03-01 to 2025-06-30"], pool, dates), []);
  // ...and without the fix the same sentence fails, which is why it ships here.
  assert.deepEqual(findUncitedNumbers(["covers 2025-03-01 to 2025-06-30"], pool), ["-30"]);
});

test("an invented date is not laundered by the date fix", () => {
  // Only dates the results contained are removed before tokenising; anything else
  // still faces the normal check. Asserted against a small pool, because the
  // derived-pair rule below makes rejection untestable on a rich one.
  const dates = ["2025-03-01"];
  assert.deepEqual(findUncitedNumbers(["covers 2025-03-01"], [5], dates), []);
  assert.deepEqual(findUncitedNumbers(["a spike on 2024-11-17"], [5], dates), ["-17"]);
});

test("a timestamp quoted at lower precision than stored still counts as cited", () => {
  const result: CitableResult = {
    rows: [{ seen_at: "2025-03-15 08:45:00", n: 7 }],
    totalRows: 1,
    digest: null,
  };
  const dates = collectDateLiterals([result], 24);
  assert.deepEqual(findUncitedNumbers(["last seen 2025-03-15 08:45"], numericPool([result], 24), dates), []);
});

test("a hyphen between two figures is a separator, not a minus sign", () => {
  // Observed in a real run: the narrator wrote "a narrow 33.9%-35.6% band" and
  // "Jan-2026", and the tokeniser read -35.6 and -2026 — figures that were plainly
  // in the results, rejected over punctuation.
  const pool = [33.9, 35.6, 0.339, 0.356];
  assert.deepEqual(findUncitedNumbers(["a narrow 33.9%-35.6% band"], pool), []);
  assert.deepEqual(findUncitedNumbers(["from Jan-2026 through Jul-2026"], []), []);
  assert.deepEqual(findUncitedNumbers(["(29.6%)-(30.7%)"], [29.6, 30.7]), []);
  // A genuine negative figure — one preceded by a space — is still checked as a
  // negative, so it must be a real value or a real difference, not merely the
  // magnitude of one.
  assert.deepEqual(findUncitedNumbers(["down -5.2pp"], [5.2]), ["-5.2"]);
  assert.deepEqual(findUncitedNumbers(["down -5.2pp"], [10, 15.2]), []); // 10 - 15.2
});

test("a year is skipped whichever side of a hyphen it lands on", () => {
  assert.deepEqual(findUncitedNumbers(["between 2025 and 2026"], []), []);
  assert.deepEqual(findUncitedNumbers(["the 2025-2026 season"], []), []);
});

test("collectDateLiterals ignores strings that merely contain digits", () => {
  const result: CitableResult = {
    rows: [{ city: "Delhi", code: "404", day: "2025-03-01" }],
    totalRows: 1,
    digest: null,
  };
  assert.deepEqual(collectDateLiterals([result], 24), ["2025-03-01"]);
});

test("the measured bounds the narrator is told to quote are citable", () => {
  // Observed live: the prompt says a caveat "must use THESE bounds", the narrator
  // quoted ±3.5pp and 86.9%, and the checker rejected both — a guaranteed retry for
  // following instructions, which then dropped confidence. The pool is assembled in
  // runAnalytics; this pins the values it has to contain.
  const [p] = precisionForRow({ otp_success_rate: 0.8364485981308412, otp_success_n: 428 },
    "SELECT x/y AS otp_success_rate, count() AS otp_success_n FROM t");
  assert.ok(p?.interval, "a rate with its denominator must be bounded");
  const pool = [
    p.value, p.n as number,
    p.interval.lo, p.interval.hi, p.interval.halfWidthPp,
    p.interval.lo * 100, p.interval.hi * 100,
  ];
  assert.deepEqual(
    findUncitedNumbers(["83.6% of OTP attempts succeed (95% CI 80.1%-87.1%, ±3.5pp on n=428)"], pool),
    [],
  );
});

// ── unchanged guarantees ─────────────────────────────────────────

test("a figure absent from a result is rejected, digest or not", () => {
  const small: CitableResult = { rows: [{ n: 6401 }], totalRows: 1, digest: null };
  assert.deepEqual(findUncitedNumbers(["a total of 88431"], numericPool([small], 24)), ["88431"]);
});

test("the sample size stated in the header is citable", () => {
  // The narrator is shown "the first 24 of 52340", so echoing 24 must not fail the
  // answer — it is the size of a set we actually hold.
  const pool = numericPool([LARGE], 24);
  assert.deepEqual(findUncitedNumbers(["24 rows are listed below"], pool), []);
});

test("derived pairs stay permissive on rich results — a known property, not a regression", () => {
  // findUncitedNumbers accepts any difference or ratio of two pooled values, so a
  // large pool accepts a lot: 24 / 0.01 is exactly 2400. This is the documented
  // trade-off that lets a narrator report deltas, and it is why the derived window
  // is capped and why shown rows are pooled first. Pinned so that a future change
  // widening the pool has to confront it deliberately.
  const pool = numericPool([LARGE], 24);
  assert.deepEqual(findUncitedNumbers(["2400"], pool), []);
  assert.deepEqual(findUncitedNumbers(["2400"], [24]), ["2400"]);
});

test("small results keep exactly the old pool behaviour", () => {
  const small: CitableResult = {
    rows: [{ os: "iOS", success_rate: 0.812, success_n: 6401 }],
    totalRows: 1,
    digest: null,
  };
  const pool = numericPool([small], 24);
  assert.deepEqual(findUncitedNumbers(["iOS succeeds 81.2% of the time on 6401 attempts"], pool), []);
  assert.deepEqual(findUncitedNumbers(["Android is at 44%"], pool), ["44"]);
});
