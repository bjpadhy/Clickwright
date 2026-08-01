import { test } from "node:test";
import assert from "node:assert/strict";
import {
  denominatorColumnFor,
  denominatorColumnsFromSql,
  findDenominator,
  precisionForRow,
} from "../../src/core/precision.js";

/**
 * An interval that looks rigorous and is wrong is worse than no interval, so a
 * denominator is only used when it demonstrably belongs to the rate it bounds.
 */

test("a bare n denominates the single rate in a row", () => {
  // The documented convention: "for a single unnamed rate, `n` is enough".
  assert.equal(findDenominator("success_rate", { success_rate: 0.8, n: 500 }), 500);
  const [p] = precisionForRow({ success_rate: 0.8, n: 500 }, "SELECT a/b AS success_rate, count() AS n FROM t");
  assert.equal(p?.n, 500);
  assert.ok(p?.interval);
});

test("a bare n is refused when the row holds more than one rate", () => {
  // Observed live: a per-segment share and a whole-population share sat in one row
  // beside a single row-local n=1. Lending that n to the global figure bounded a
  // 35.2% rate at ±44pp when its true bound was ±1.1pp.
  const row = { destination: "VN", guest_share: 0, overall_guest_share: 0.3519, n: 1 };
  assert.equal(findDenominator("overall_guest_share", row), null);
  assert.equal(findDenominator("guest_share", row), null);

  const sql = "SELECT destination, x/y AS guest_share, a/b AS overall_guest_share, count() AS n FROM t";
  for (const p of precisionForRow(row, sql)) {
    assert.equal(p.interval, null, `${p.column} must not be bounded by an ambiguous n`);
    assert.match(p.note, /no denominator/);
  }
});

test("an explicitly named denominator is used even beside several rates", () => {
  // Naming removes the ambiguity, which is why the SQL prompt insists on it.
  const row = { guest_share: 0.29, guest_n: 119, overall_guest_share: 0.352, overall_guest_n: 6715 };
  assert.equal(findDenominator("guest_share", row), 119);
  assert.equal(findDenominator("overall_guest_share", row), 6715);
});

test("the digest's own naming is unambiguous by construction", () => {
  // Population figures always ship a prefixed denominator, so the rule above never
  // costs the whole-set rate its interval.
  const row = { full_guest_rate: 0.3536, full_guest_n: 2363, full_overall_guest_rate: 0.3519, full_overall_guest_n: 6715 };
  assert.equal(findDenominator("full_guest_rate", row), 2363);
  assert.equal(findDenominator("full_overall_guest_rate", row), 6715);
});

test("denominatorColumnFor resolves a name without needing a row", () => {
  assert.equal(denominatorColumnFor("otp_success_rate", ["otp_success_rate", "otp_success_n"]), "otp_success_n");
  assert.equal(denominatorColumnFor("conversion_rate", ["conversion_rate", "conversion_total"]), "conversion_total");
  assert.equal(denominatorColumnFor("rate", ["rate", "n"]), "n");
  assert.equal(denominatorColumnFor("conversion_rate", ["conversion_rate", "city"]), null);
  // must never nominate the rate column as its own denominator
  assert.equal(denominatorColumnFor("n_rate", ["n_rate"]), null);
});

const FUNNEL_SQL = `SELECT city,
  uniqExact(user_id) AS offer_shown_n,
  uniqExactIf(user_id, purchased = 1) AS purchased_n,
  purchased_n / offer_shown_n AS attach_rate
FROM events GROUP BY city`;

test("denominatorColumnsFromSql reads the divisor straight from the division", () => {
  // A funnel rate spans two stages: no naming convention connects attach_rate to
  // offer_shown_n, but the SQL states the division outright.
  assert.deepEqual(
    denominatorColumnsFromSql("attach_rate", FUNNEL_SQL, ["offer_shown_n", "purchased_n"]),
    ["offer_shown_n"],
  );
});

test("denominatorColumnsFromSql resolves a divisor expression to the column that selects it", () => {
  const sql = `SELECT
    uniqExact(user_id) AS offer_shown_n,
    uniqExactIf(user_id, purchased = 1) / uniqExact(user_id) AS attach_rate
  FROM events GROUP BY city`;
  assert.deepEqual(
    denominatorColumnsFromSql("attach_rate", sql, ["offer_shown_n"]),
    ["offer_shown_n"],
  );
});

test("denominatorColumnsFromSql returns nothing rather than guessing", () => {
  // not a division at all
  assert.deepEqual(denominatorColumnsFromSql("rate", "SELECT avg(ok) AS rate FROM t", ["n"]), []);
  // the divisor exists in the SQL but is not a column of the result
  assert.deepEqual(denominatorColumnsFromSql("rate", "SELECT a / b AS rate FROM t", ["n"]), []);
  // must never nominate the rate column as its own denominator
  assert.deepEqual(denominatorColumnsFromSql("rate", "SELECT x / rate AS rate FROM t", ["rate"]), []);
});

test("a funnel rate is bounded by the count it divides by, not a name-matched column", () => {
  const [p] = precisionForRow(
    { offer_shown_n: 500, purchased_n: 100, attach_rate: 0.2 },
    FUNNEL_SQL,
  );
  assert.equal(p?.column, "attach_rate");
  assert.equal(p?.n, 500);
  assert.ok(p?.interval, "the division names its denominator, so the rate must be bounded");
});
