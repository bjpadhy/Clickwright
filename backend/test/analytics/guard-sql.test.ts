import { test } from "node:test";
import assert from "node:assert/strict";
import { guardSql, guardSqlParts } from "../../src/agents/analytics.js";

/**
 * `guardSql`'s output is stored: saved dashboards keep the exact text and re-run it
 * on every load. Splitting it into parts must therefore be a pure refactor — these
 * cases pin the historical bytes, not just the semantics.
 */

test("guardSql appends the transport cap when the model wrote no LIMIT", () => {
  assert.equal(guardSql("SELECT count() FROM t"), "SELECT count() FROM t\nLIMIT 1000");
});

test("guardSql leaves a within-cap authored LIMIT byte-for-byte alone", () => {
  // Reformatting here would rewrite every saved board on its next save.
  const sql = "SELECT city, rate FROM t ORDER BY rate DESC LIMIT 10";
  assert.equal(guardSql(sql), sql);
  assert.equal(guardSql("SELECT a FROM t\n  LIMIT 25  "), "SELECT a FROM t\n  LIMIT 25");
});

test("guardSql clamps an oversized LIMIT instead of rejecting a good query", () => {
  assert.equal(guardSql("SELECT a FROM t LIMIT 5000"), "SELECT a FROM t LIMIT 1000");
  assert.equal(guardSql("SELECT a FROM t\nLIMIT 1001"), "SELECT a FROM t\nLIMIT 1000");
});

test("guardSql strips fences and a trailing semicolon before validating", () => {
  assert.equal(guardSql("```sql\nSELECT 1 AS a;\n```"), "SELECT 1 AS a\nLIMIT 1000");
});

test("guardSql rejects anything that is not a single read-only statement", () => {
  assert.throws(() => guardSql("SELECT 1; SELECT 2"), /exactly one statement/);
  assert.throws(() => guardSql("DESCRIBE TABLE t"), /must start with SELECT or WITH/);
  assert.throws(() => guardSql("SELECT 1 FROM t WHERE x IN (INSERT)"), /banned keyword/);
  assert.throws(() => guardSql("SELECT 1 SETTINGS max_threads = 4"), /banned keyword/);
});

test("guardSqlParts separates the authored LIMIT from the statement", () => {
  const withLimit = guardSqlParts("SELECT city FROM t ORDER BY n DESC LIMIT 10");
  assert.equal(withLimit.authoredLimit, 10);
  assert.equal(withLimit.core, "SELECT city FROM t ORDER BY n DESC");
  assert.equal(withLimit.validated, "SELECT city FROM t ORDER BY n DESC LIMIT 10");

  const without = guardSqlParts("SELECT city FROM t");
  assert.equal(without.authoredLimit, null);
  assert.equal(without.core, "SELECT city FROM t");
  assert.equal(without.core, without.validated);
});

test("guardSqlParts treats a CTE as one statement and keeps it whole", () => {
  const parts = guardSqlParts("WITH s AS (SELECT 1 AS a) SELECT a FROM s LIMIT 5");
  assert.equal(parts.authoredLimit, 5);
  assert.equal(parts.core, "WITH s AS (SELECT 1 AS a) SELECT a FROM s");
});

test("guardSqlParts only reads a LIMIT that ends the statement", () => {
  // `LIMIT n BY col` and `LIMIT n OFFSET m` are not the trailing-count shape, so they
  // pass through untouched and the transport cap is appended as usual — the same
  // behaviour these forms have always had.
  const limitBy = guardSqlParts("SELECT a FROM t LIMIT 1 BY city");
  assert.equal(limitBy.authoredLimit, null);
  assert.equal(guardSql("SELECT a FROM t LIMIT 1 BY city"), "SELECT a FROM t LIMIT 1 BY city\nLIMIT 1000");

  const offset = guardSqlParts("SELECT a FROM t LIMIT 10 OFFSET 5");
  assert.equal(offset.authoredLimit, null);

  // ...but `LIMIT 1 BY city LIMIT 100` does end in a count, and that count is the
  // authored one.
  const both = guardSqlParts("SELECT a FROM t LIMIT 1 BY city LIMIT 100");
  assert.equal(both.authoredLimit, 100);
  assert.equal(both.core, "SELECT a FROM t LIMIT 1 BY city");
});
