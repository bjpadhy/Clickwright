import { test } from "node:test";
import assert from "node:assert/strict";
import { denominatorColumnsFromSql, unwrapDivisor } from "../../src/core/precision.js";

/**
 * A rate whose divisor cannot be resolved gets no interval, and the digest can
 * compute no whole-population rate either — so a correct, verified answer is
 * reported as low confidence. Measured on one question across two runs: written
 * `purchase_n / pay_now_n` it scored 0.79; written
 * `purchase_n / NULLIF(p.pay_now_n, 0)` — the CORRECT way to divide safely —
 * the same figure scored 0.31.
 */

const COLS = ["os_bucket", "pay_now_n", "purchase_n", "conversion_rate"];

test("a NULLIF-guarded divisor resolves to its column", () => {
  const sql = "SELECT purchase_n / NULLIF(p.pay_now_n, 0) AS conversion_rate FROM t";
  assert.deepEqual(denominatorColumnsFromSql("conversion_rate", sql, COLS), ["pay_now_n"]);
});

test("the plain form still resolves", () => {
  const sql = "SELECT purchase_n / pay_now_n AS conversion_rate FROM t";
  assert.deepEqual(denominatorColumnsFromSql("conversion_rate", sql, COLS), ["pay_now_n"]);
});

test("the real statement from the live run resolves", () => {
  const sql = `SELECT
    p.os_bucket,
    p.pay_now_n,
    coalesce(c.purchase_n, 0) AS purchase_n,
    purchase_n / NULLIF(p.pay_now_n, 0) AS conversion_rate
FROM a AS p LEFT JOIN b AS c ON p.os_bucket = c.os_bucket`;
  assert.deepEqual(denominatorColumnsFromSql("conversion_rate", sql, COLS), ["pay_now_n"]);
});

test("every safe-divide idiom unwraps to the same column", () => {
  for (const divisor of [
    "pay_now_n",
    "NULLIF(pay_now_n, 0)",
    "nullIf(p.pay_now_n, 0)",
    "coalesce(pay_now_n, 0)",
    "greatest(pay_now_n, 1)",
    "toFloat64(pay_now_n)",
    "CAST(pay_now_n AS Float64)",
    "assumeNotNull(pay_now_n)",
    "(pay_now_n)",
    "toFloat64(NULLIF(p.pay_now_n, 0))",
  ]) {
    const sql = `SELECT purchase_n / ${divisor} AS conversion_rate FROM t`;
    assert.deepEqual(
      denominatorColumnsFromSql("conversion_rate", sql, COLS),
      ["pay_now_n"],
      divisor,
    );
  }
});

test("unwrapping stops at a real expression", () => {
  // Not a wrapper — the divisor is a computed value, not a column reference.
  assert.equal(unwrapDivisor("sum(pay_now_n)"), "sum(pay_now_n)");
  assert.equal(unwrapDivisor("pay_now_n + purchase_n"), "pay_now_n + purchase_n");
  // …and a wrapper around a real expression unwraps only the wrapper
  assert.equal(unwrapDivisor("NULLIF(sum(pay_now_n), 0)"), "sum(pay_now_n)");
});

test("a divisor naming no returned column still yields nothing", () => {
  // The guard against inventing a denominator must survive the unwrapping.
  const sql = "SELECT purchase_n / NULLIF(some_other_table.n, 0) AS conversion_rate FROM t";
  assert.deepEqual(denominatorColumnsFromSql("conversion_rate", sql, COLS), []);
});

test("a wrapper is not confused with an aggregate of the same shape", () => {
  // `uniqExact(x)` is not a pass-through: its value is not column x.
  const sql = "SELECT purchase_n / uniqExact(application_id) AS conversion_rate FROM t";
  assert.deepEqual(
    denominatorColumnsFromSql("conversion_rate", sql, [...COLS, "application_id"]),
    [],
  );
});

test("the rate column can never be its own denominator", () => {
  const sql = "SELECT x / NULLIF(conversion_rate, 0) AS conversion_rate FROM t";
  assert.deepEqual(denominatorColumnsFromSql("conversion_rate", sql, COLS), []);
});

// ── a CAST inside another wrapper ──────────────────────────────────

/**
 * `nullIf(CAST(n AS Float64), 0)` is the most idiomatic safe division in
 * ClickHouse. Stripping ` AS <type>` from the first argument of EVERY wrapper ate
 * the nested call's closing paren — the pattern has to allow parens so
 * `Decimal(10, 2)` survives — leaving the unparseable `CAST(p.pay_now_n`. No
 * column was found, the rate went unbounded, and a verified answer was capped at
 * 0.60 by `no_bounded_precision`.
 */
test("a CAST nested inside a wrapper still resolves to its column", () => {
  // the table qualifier is stripped later, by denominatorColumnsFromSql
  assert.equal(unwrapDivisor("nullIf(CAST(p.pay_now_n AS Float64), 0)"), "p.pay_now_n");
  assert.equal(unwrapDivisor("coalesce(CAST(pay_now_n AS UInt64), 0)"), "pay_now_n");
  assert.equal(unwrapDivisor("toFloat64(cast(pay_now_n as Float64))"), "pay_now_n");
});

test("a parameterised cast type does not break the unwrap", () => {
  assert.equal(unwrapDivisor("nullIf(CAST(pay_now_n AS Decimal(10, 2)), 0)"), "pay_now_n");
});

test("the two-argument CAST form still resolves", () => {
  assert.equal(unwrapDivisor("nullIf(CAST(pay_now_n, 'Float64'), 0)"), "pay_now_n");
});

test("a cast divisor is found in a whole SELECT", () => {
  const sql =
    "SELECT purchase_n / nullIf(CAST(p.pay_now_n AS Float64), 0) AS conversion_rate, " +
    "p.pay_now_n AS pay_now_n FROM t p";
  assert.deepEqual(denominatorColumnsFromSql("conversion_rate", sql, COLS), ["pay_now_n"]);
});
