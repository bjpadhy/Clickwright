import { test } from "node:test";
import assert from "node:assert/strict";
import {
  denominatorColumnFor,
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
