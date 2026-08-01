/**
 * Smoke test for the one assumption the full-result-set digest rests on: that a
 * task query can be wrapped as a parenthesized subquery and aggregated over,
 * under the same readonly=1 the analytics agent uses.
 *
 * Run: npm run check-wrap  (from backend/)
 *
 * The digest degrades honestly when a wrap fails, so a failure here is not fatal
 * — but it tells us which shapes to expect notes for instead of numbers.
 */
import { closeDb, queryReadonly } from "../src/core/db.js";

const CASES: Array<{ name: string; sql: string }> = [
  {
    name: "plain SELECT wrapped",
    sql: `SELECT count() AS total_rows FROM (SELECT number AS n FROM system.numbers LIMIT 100) AS q`,
  },
  {
    name: "CTE (WITH ... SELECT) wrapped — the shape every WITH-style task query needs",
    sql: `SELECT count() AS total_rows, max(n) AS n_max FROM (WITH src AS (SELECT number AS n FROM system.numbers LIMIT 50) SELECT n FROM src) AS q`,
  },
  {
    name: "wrapped query keeping its own ORDER BY + LIMIT (authored top-N semantics)",
    sql: `SELECT count() AS total_rows, min(n) AS n_min FROM (SELECT number AS n FROM system.numbers WHERE number < 1000 ORDER BY n DESC LIMIT 10) AS q`,
  },
  {
    name: "weighted rate + denominator, the headline digest emission",
    sql: `SELECT sum(r * n) / sum(n) AS full_x_rate, toUInt64(sum(n)) AS full_x_n, countIf(r > 1.05) AS x_gt1_n
          FROM (SELECT number / 100 AS r, number + 10 AS n FROM system.numbers LIMIT 20) AS q`,
  },
  {
    name: "extremes: real rows of the result set by a metric",
    sql: `SELECT * FROM (SELECT number AS n, number / 50 AS x_rate FROM system.numbers LIMIT 40) AS q ORDER BY x_rate ASC LIMIT 5`,
  },
  {
    name: "UNION ALL result wrapped",
    sql: `SELECT count() AS total_rows FROM (SELECT 1 AS n UNION ALL SELECT 2 AS n) AS q`,
  },
  {
    name: "DESCRIBE of a subquery — exact column types without scanning data",
    sql: `DESCRIBE (SELECT number AS n, toString(number) AS label, now() AS ts FROM system.numbers LIMIT 1)`,
  },
  {
    name: "DESCRIBE of a CTE subquery",
    sql: `DESCRIBE (WITH src AS (SELECT 1 AS a) SELECT a, toDate('2025-03-15') AS d FROM src)`,
  },
  {
    name: "quantile + uniq + date range in one digest pass",
    sql: `SELECT quantile(0.5)(x) AS x_p50_approx, uniq(label) AS label_distinct_approx,
                 min(d) AS d_min, max(d) AS d_max
          FROM (SELECT number / 7 AS x, toString(number % 3) AS label,
                       toDate('2025-03-01') + number AS d FROM system.numbers LIMIT 30) AS q`,
  },
];

async function main(): Promise<void> {
  let failures = 0;
  for (const c of CASES) {
    try {
      const rows = await queryReadonly(c.sql);
      console.log(`  ok   ${c.name}\n       → ${JSON.stringify(rows).slice(0, 200)}`);
    } catch (error) {
      failures++;
      const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
      console.log(`  FAIL ${c.name}\n       → ${message}`);
    }
  }
  console.log(
    failures === 0
      ? "\nAll wrap shapes execute under readonly=1 — the digest can wrap task SQL directly."
      : `\n${failures}/${CASES.length} shapes failed — those tasks will degrade to a digest note.`,
  );
  await closeDb();
  process.exit(failures === 0 ? 0 : 1);
}

void main();
