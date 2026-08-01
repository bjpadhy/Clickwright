import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSafeStatement } from "../../src/agents/optimizer.js";

/**
 * This validator is the boundary between an LLM and DDL running on a live
 * database, so it is tested as an adversary would probe it, not just for the
 * happy path.
 */

const ALLOWED = [
  "ALTER TABLE landing_page_scrolled MODIFY TTL timestamp + INTERVAL 6 MONTH",
  "alter table atlys_dataset.document_uploaded add column fmt LowCardinality(String) MATERIALIZED attrs['format']",
  "ALTER TABLE purchase_completed MODIFY COLUMN currency LowCardinality(String)",
  "CREATE MATERIALIZED VIEW mv_daily ENGINE = AggregatingMergeTree ORDER BY d AS SELECT toDate(timestamp) AS d, count() AS c FROM purchase_completed GROUP BY d",
  "CREATE MATERIALIZED VIEW IF NOT EXISTS mv_x ENGINE = SummingMergeTree ORDER BY k AS SELECT user_id AS k, count() AS c FROM auth_completed GROUP BY k",
  "OPTIMIZE TABLE search_typed FINAL",
];

for (const sql of ALLOWED) {
  test(`allows: ${sql.slice(0, 52)}…`, () => {
    assert.doesNotThrow(() => assertSafeStatement(sql));
  });
}

const REJECTED: Array<[string, string]> = [
  ["DROP TABLE purchase_completed", "a bare drop"],
  ["drop table if exists purchase_completed", "a lowercase drop"],
  ["TRUNCATE TABLE runs_log", "a truncate"],
  ["RENAME TABLE a TO b", "a rename"],
  ["ALTER TABLE t DELETE WHERE 1=1", "a mutation disguised as an ALTER"],
  ["INSERT INTO purchase_completed SELECT * FROM other", "a write"],
  ["SELECT * FROM purchase_completed", "a plain select"],
  ["SYSTEM DROP REPLICA 'x'", "a system command"],
  ["GRANT ALL ON *.* TO bob", "a privilege change"],
  ["DETACH TABLE purchase_completed", "a detach"],
  ["", "an empty statement"],
  ["   ", "whitespace only"],
];

for (const [sql, description] of REJECTED) {
  test(`rejects ${description}`, () => {
    assert.throws(() => assertSafeStatement(sql));
  });
}

test("rejects a second statement smuggled in behind a legitimate one", () => {
  assert.throws(
    () =>
      assertSafeStatement(
        "ALTER TABLE t MODIFY TTL timestamp + INTERVAL 6 MONTH; DROP TABLE purchase_completed",
      ),
    /several/i,
  );
});

test("rejects a DROP hidden inside a materialized view body", () => {
  assert.throws(
    () =>
      assertSafeStatement(
        "CREATE MATERIALIZED VIEW mv ENGINE = MergeTree ORDER BY d AS SELECT 1 AS d FROM t WHERE 1=1 -- DROP TABLE t",
      ),
    /forbidden keyword/i,
  );
});

test("tolerates a single trailing semicolon", () => {
  assert.doesNotThrow(() =>
    assertSafeStatement("OPTIMIZE TABLE search_typed FINAL;"),
  );
});

test("tolerates leading whitespace and newlines from a model's formatting", () => {
  assert.doesNotThrow(() =>
    assertSafeStatement("\n  ALTER TABLE t MODIFY TTL timestamp + INTERVAL 90 DAY\n"),
  );
});

test("rejects an ALTER that targets no table", () => {
  assert.throws(() => assertSafeStatement("ALTER TABLE MODIFY TTL x"));
});
