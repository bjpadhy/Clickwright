import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blankStringLiterals,
  guardSql,
  guardSqlParts,
  hasTopLevelOrderBy,
  topLevelSql,
} from "../../src/agents/analytics.js";

/**
 * `guardSql`'s output is stored: saved dashboards keep the exact text and re-run it
 * on every load, so these cases pin the exact bytes, not just the semantics.
 *
 * The cap now also fixes WHICH rows cross the wire. `LIMIT 1000` on an unordered
 * result returns an arbitrary thousand, and the narrator's chart is built from the
 * first 24 of them — the same question could show different segments run to run.
 * Every test passes `orderByAll` explicitly so the suite does not depend on the
 * environment.
 */
const ON = { orderByAll: true };
const OFF = { orderByAll: false };

test("guardSql orders the result before capping it, so the capped rows are the same every run", () => {
  assert.equal(
    guardSql("SELECT count() FROM t", ON),
    "SELECT count() FROM t\nORDER BY ALL\nLIMIT 1000",
  );
  // the escape hatch for a ClickHouse below 23.12, or a column literally named `all`
  assert.equal(guardSql("SELECT count() FROM t", OFF), "SELECT count() FROM t\nLIMIT 1000");
});

test("an authored ORDER BY is left to decide the order", () => {
  assert.equal(
    guardSql("SELECT city, n FROM t ORDER BY n DESC", ON),
    "SELECT city, n FROM t ORDER BY n DESC\nLIMIT 1000",
  );
});

test("an ORDER BY inside a subquery or CTE does not order the outer result", () => {
  // The outer SELECT is still unordered, so it still needs ORDER BY ALL.
  assert.equal(
    guardSql("SELECT a FROM (SELECT a FROM t ORDER BY a) AS q", ON),
    "SELECT a FROM (SELECT a FROM t ORDER BY a) AS q\nORDER BY ALL\nLIMIT 1000",
  );
  assert.equal(hasTopLevelOrderBy("SELECT a FROM (SELECT a FROM t ORDER BY a) AS q"), false);
  assert.equal(hasTopLevelOrderBy("WITH s AS (SELECT 1 AS a ORDER BY a) SELECT a FROM s"), false);
  assert.equal(hasTopLevelOrderBy("SELECT a FROM t ORDER BY a"), true);
  // an ORDER BY mentioned inside a string literal is text, not a clause
  assert.equal(hasTopLevelOrderBy("SELECT 'order by x' AS note FROM t"), false);
});

test("shapes ORDER BY ALL would break keep the plain cap", () => {
  // `LIMIT n BY col` must stay adjacent to its select — an ORDER BY cannot sit
  // between them...
  assert.equal(
    guardSql("SELECT a FROM t LIMIT 1 BY city", ON),
    "SELECT a FROM t LIMIT 1 BY city\nLIMIT 1000",
  );
  // ...and on a top-level UNION an appended ORDER BY would bind to one arm only.
  assert.equal(
    guardSql("SELECT a FROM t UNION ALL SELECT a FROM u", ON),
    "SELECT a FROM t UNION ALL SELECT a FROM u\nLIMIT 1000",
  );
});

test("an authored LIMIT with an OFFSET is left exactly as written", () => {
  // A second LIMIT after `LIMIT n OFFSET m` is a syntax error — the query failed
  // and the task burned a retry rewriting SQL that was already correct.
  assert.equal(guardSql("SELECT a FROM t LIMIT 10 OFFSET 5", ON), "SELECT a FROM t LIMIT 10 OFFSET 5");
  assert.equal(guardSql("SELECT a FROM t LIMIT 5, 10", ON), "SELECT a FROM t LIMIT 5, 10");
});

test("an oversized LIMIT with an OFFSET is clamped, not waved through", () => {
  // ClickHouse Cloud pins this user to readonly=1 and discards row-limit settings,
  // so the transport cap only exists here. A second LIMIT cannot follow this form,
  // which meant the whole cap was bypassed by writing an OFFSET: the magnitude is
  // the point, not the pass-through.
  assert.equal(
    guardSql("SELECT a FROM t LIMIT 50000 OFFSET 0", ON),
    "SELECT a FROM t LIMIT 1000 OFFSET 0",
  );
  // the offset — and so which page is fetched — survives the clamp
  assert.equal(
    guardSql("SELECT a FROM t LIMIT 20000 OFFSET 4000", ON),
    "SELECT a FROM t LIMIT 1000 OFFSET 4000",
  );
  // `LIMIT <offset>, <count>` clamps the COUNT, which is the second number
  assert.equal(
    guardSql("SELECT a FROM t LIMIT 5, 50000", ON),
    "SELECT a FROM t LIMIT 5, 1000",
  );
  // whichever form was written, the number of rows fetched is at most the cap
  const rowsFetched = (sql: string): number => {
    const m = /\blimit\s+(\d+)\s*(?:,\s*(\d+)|\s+offset\s+\d+)/i.exec(sql)!;
    return Number(m[2] ?? m[1]);
  };
  for (const sql of [
    "SELECT a FROM t LIMIT 50000 OFFSET 0",
    "SELECT a FROM t LIMIT 5, 50000",
    "SELECT a FROM t LIMIT 1001 OFFSET 7",
    "SELECT a FROM t LIMIT 10 OFFSET 5",
  ]) {
    const capped = guardSql(sql, ON);
    assert.ok(rowsFetched(capped) <= 1000, `${sql} -> ${capped}`);
  }
});

test("guardSql leaves a within-cap authored LIMIT byte-for-byte alone", () => {
  // Reformatting here would rewrite every saved board on its next save.
  const sql = "SELECT city, rate FROM t ORDER BY rate DESC LIMIT 10";
  assert.equal(guardSql(sql, ON), sql);
  assert.equal(guardSql("SELECT a FROM t\n  LIMIT 25  ", ON), "SELECT a FROM t\n  LIMIT 25");
});

test("guardSql clamps an oversized LIMIT instead of rejecting a good query", () => {
  assert.equal(guardSql("SELECT a FROM t LIMIT 5000", ON), "SELECT a FROM t LIMIT 1000");
  assert.equal(guardSql("SELECT a FROM t\nLIMIT 1001", ON), "SELECT a FROM t\nLIMIT 1000");
});

test("guardSql strips fences and a trailing semicolon before validating", () => {
  assert.equal(guardSql("```sql\nSELECT 1 AS a;\n```", ON), "SELECT 1 AS a\nORDER BY ALL\nLIMIT 1000");
});

test("guardSql rejects anything that is not a single read-only statement", () => {
  assert.throws(() => guardSql("SELECT 1; SELECT 2"), /exactly one statement/);
  assert.throws(() => guardSql("DESCRIBE TABLE t"), /must start with SELECT or WITH/);
  assert.throws(() => guardSql("SELECT 1 FROM t WHERE x IN (INSERT)"), /banned keyword/);
  assert.throws(() => guardSql("SELECT 1 SETTINGS max_threads = 4"), /banned keyword/);
});

test("a banned keyword inside a string literal is data, not a statement", () => {
  // The SQL writer's own "cannot compute" sentinel carries a prose reason, and a
  // reason containing "set" ("the data set has no …") was rejected as a SETTINGS
  // clause — the task died on the path that exists for reporting honestly.
  const sentinel =
    "SELECT 'cannot compute' AS blocked, 'the data set has no coupon column' AS reason";
  assert.equal(guardSql(sentinel, OFF), `${sentinel}\nLIMIT 1000`);
  assert.equal(
    guardSql("SELECT city FROM t WHERE note = 'drop off after insert'", OFF),
    "SELECT city FROM t WHERE note = 'drop off after insert'\nLIMIT 1000",
  );
  // ...while the real thing is still refused
  assert.throws(() => guardSql("SELECT 1 FROM t; DROP TABLE t"), /exactly one statement/);
  assert.throws(() => guardSql("SELECT 1 SETTINGS max_threads = 4"), /banned keyword/);
});

test("blankStringLiterals keeps the statement's shape while emptying its text", () => {
  assert.equal(blankStringLiterals("SELECT 'a set' AS x, b FROM t"), "SELECT '' AS x, b FROM t");
  // an escaped or doubled quote does not end the literal early
  assert.equal(blankStringLiterals("SELECT 'it''s set' AS x"), "SELECT '' AS x");
});

test("an apostrophe inside a quoted identifier does not open a phantom literal", () => {
  // The guard regression: with no notion of `"…"`, the apostrophe in `"o'clock"`
  // opened a literal that swallowed the middle of the statement — `system` vanished
  // and the ban check PASSED on a query reading system.tables.
  const sql = `SELECT count() AS n FROM "o'clock", system.tables WHERE x='y'`;
  const blanked = blankStringLiterals(sql);
  assert.match(blanked, /system\.tables/, "the statement's own text must survive");
  assert.match(blanked, /"o'clock"/, "a quoted identifier is a name, not a literal");
  assert.equal(blanked.includes("'y'"), false, "the real literal is still blanked");
  assert.throws(() => guardSql(sql, ON), /banned keyword/);

  // backticks are the other identifier quote
  assert.match(blankStringLiterals("SELECT `it's fine` FROM t"), /`it's fine`/);
  // an unterminated literal is left as written rather than blanking what follows
  assert.throws(() => guardSql("SELECT 'abc FROM system.tables", ON), /banned keyword/);
});

test("a parenthesis inside a quoted identifier does not unbalance the depth count", () => {
  // An unbalanced paren in a NAME made topLevelSql drop the rest of the statement,
  // so an authored ORDER BY went unseen and ORDER BY ALL was appended after it —
  // a syntax error and a wasted retry.
  const sql = 'SELECT city, n AS "revenue (usd" FROM t ORDER BY n DESC';
  assert.match(topLevelSql(sql), /order\s+by\s+n\s+DESC/i);
  assert.equal(hasTopLevelOrderBy(sql), true);
  assert.equal(guardSql(sql, ON), `${sql}\nLIMIT 1000`);
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
  // `LIMIT n BY col` and `LIMIT n OFFSET m` are not the trailing-count shape, so
  // they are not read as an authored limit.
  const limitBy = guardSqlParts("SELECT a FROM t LIMIT 1 BY city");
  assert.equal(limitBy.authoredLimit, null);
  assert.equal(
    guardSql("SELECT a FROM t LIMIT 1 BY city", ON),
    "SELECT a FROM t LIMIT 1 BY city\nLIMIT 1000",
  );

  const offset = guardSqlParts("SELECT a FROM t LIMIT 10 OFFSET 5");
  assert.equal(offset.authoredLimit, null);

  // ...but `LIMIT 1 BY city LIMIT 100` does end in a count, and that count is the
  // authored one.
  const both = guardSqlParts("SELECT a FROM t LIMIT 1 BY city LIMIT 100");
  assert.equal(both.authoredLimit, 100);
  assert.equal(both.core, "SELECT a FROM t LIMIT 1 BY city");
});
