import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkConventions,
  checkDenominator,
  overallFrom,
  sqlSkeleton,
  tablesUsed,
} from "../../src/agents/judge.js";
import { extractJson } from "../../src/core/llm.js";
import type { AnswerEvidence } from "../../src/agents/analytics.js";

/**
 * These are the checks that keep the judge from being a rubber stamp: each one
 * is a documented trap from base_context.md, decided by code rather than by a
 * model. Every trap gets a positive and a negative case.
 */

const FLAGGED = new Set(["purchase_completed", "destination_card_clicked", "application_started"]);

function ev(sql: string, over: Partial<AnswerEvidence> = {}): AnswerEvidence {
  return {
    task: "t1",
    title: "test task",
    sql,
    rowCount: 10,
    rows: [{ n: 1 }],
    flags: [],
    ...over,
  };
}

const kinds = (sql: string, over?: Partial<AnswerEvidence>) =>
  checkConventions(ev(sql, over), FLAGGED).map((f) => f.kind);

// ── helpers ──────────────────────────────────────────────────────

test("sqlSkeleton strips literals and comments so keywords inside them do not match", () => {
  const body = sqlSkeleton("SELECT 'duplicate_id IS NULL' AS x -- is_back_filled\nFROM t");
  assert.ok(!body.includes("duplicate_id"));
  assert.ok(!body.includes("is_back_filled"));
  assert.ok(body.includes("from t"));
});

test("tablesUsed finds FROM and JOIN targets", () => {
  assert.deepEqual(
    tablesUsed("SELECT * FROM purchase_completed p JOIN application_started a ON 1").sort(),
    ["application_started", "purchase_completed"],
  );
});

// ── data hygiene ─────────────────────────────────────────────────

test("flags a missing duplicate_id filter on a flagged table", () => {
  assert.ok(kinds("SELECT count() FROM purchase_completed WHERE is_back_filled = 0").includes("hygiene"));
});

test("flags a missing is_back_filled filter", () => {
  assert.ok(kinds("SELECT count() FROM purchase_completed WHERE duplicate_id IS NULL").includes("hygiene"));
});

test("clean hygiene on a flagged table produces no hygiene finding", () => {
  const found = kinds(
    "SELECT count() FROM purchase_completed WHERE duplicate_id IS NULL AND is_back_filled = 0",
  );
  assert.ok(!found.includes("hygiene"));
});

test("does not demand hygiene filters on tables that lack the columns", () => {
  // A findings list full of false positives teaches people to ignore it.
  assert.deepEqual(kinds("SELECT count() FROM context_store"), []);
});

// ── currency ─────────────────────────────────────────────────────

test("flags sum(value) without GROUP BY currency", () => {
  assert.ok(
    kinds(
      "SELECT sum(value) FROM purchase_completed WHERE duplicate_id IS NULL AND is_back_filled = 0",
    ).includes("currency"),
  );
});

test("accepts sum(value) when grouped by currency", () => {
  assert.ok(
    !kinds(
      "SELECT currency, sum(value) FROM purchase_completed WHERE duplicate_id IS NULL AND is_back_filled = 0 GROUP BY currency",
    ).includes("currency"),
  );
});

// ── os bucketing ─────────────────────────────────────────────────

test("warns on an os cut that does not bucket empties", () => {
  assert.ok(
    kinds(
      "SELECT os, count() FROM purchase_completed WHERE duplicate_id IS NULL AND is_back_filled = 0 GROUP BY os",
    ).includes("hygiene"),
  );
});

test("accepts an os cut that buckets NULL and empty", () => {
  const found = checkConventions(
    ev(
      "SELECT if(os IS NULL OR os = '', 'unknown', os) AS os, count() FROM purchase_completed WHERE duplicate_id IS NULL AND is_back_filled = 0 GROUP BY os",
    ),
    FLAGGED,
  );
  assert.equal(found.filter((f) => f.text.includes("bucketing")).length, 0);
});

// ── top-of-funnel join ───────────────────────────────────────────

test("flags a destination_card_clicked join on application_id", () => {
  assert.ok(
    kinds(
      "SELECT count() FROM destination_card_clicked d JOIN application_started a ON d.application_id = a.application_id WHERE d.duplicate_id IS NULL AND d.is_back_filled = 0",
    ).includes("join"),
  );
});

test("accepts a destination_card_clicked join on user_id", () => {
  assert.ok(
    !kinds(
      "SELECT count() FROM destination_card_clicked d JOIN application_started a ON d.user_id = a.user_id WHERE d.duplicate_id IS NULL AND d.is_back_filled = 0",
    ).includes("join"),
  );
});

// ── coverage ─────────────────────────────────────────────────────

test("an empty result set is surfaced as a coverage finding", () => {
  const clean =
    "SELECT count() FROM purchase_completed WHERE duplicate_id IS NULL AND is_back_filled = 0";
  assert.ok(kinds(clean, { rowCount: 0, rows: [] }).includes("coverage"));
  assert.ok(!kinds(clean).includes("coverage"));
});

test("sanity-gate drops and flags become findings", () => {
  const clean =
    "SELECT count() FROM purchase_completed WHERE duplicate_id IS NULL AND is_back_filled = 0";
  const found = checkConventions(
    ev(clean, { dropped: "empty result set", flags: ["rate above 100%"] }),
    FLAGGED,
  );
  assert.equal(found.filter((f) => f.kind === "coverage").length, 2);
});

// ── denominator ──────────────────────────────────────────────────

test("warns when a conversion question is answered per user", () => {
  const found = checkDenominator("What is our conversion rate?", [
    ev("SELECT count(DISTINCT user_id) FROM purchase_completed"),
  ]);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.kind, "denominator");
});

test("accepts a conversion question answered per session", () => {
  assert.deepEqual(
    checkDenominator("What is our conversion rate?", [
      ev("SELECT count(DISTINCT app_session_id) FROM purchase_completed"),
    ]),
    [],
  );
});

test("does not raise the denominator question for unrelated questions", () => {
  assert.deepEqual(
    checkDenominator("Which destinations are most popular?", [
      ev("SELECT count(DISTINCT user_id) FROM destination_card_clicked"),
    ]),
    [],
  );
});

// ── overall ──────────────────────────────────────────────────────

test("overall takes the worst of the two axes", () => {
  assert.equal(overallFrom("pass", "pass"), "pass");
  assert.equal(overallFrom("pass", "warn"), "warn");
  assert.equal(overallFrom("warn", "fail"), "fail");
  assert.equal(overallFrom("fail", "pass"), "fail");
});

// ── JSON extraction from model output ────────────────────────────
// A reasoning model asked for "ONLY JSON" still sometimes writes a sentence
// first or leaves a trailing comma. Both cost a real judgement in testing.

test("extractJson survives prose before the object", () => {
  const out = extractJson<{ a: number }>('Here is my assessment:\n{"a": 1}')
  assert.deepEqual(out, { a: 1 })
})

test("extractJson survives a trailing comma", () => {
  assert.deepEqual(extractJson('{"a": 1, "b": 2,}'), { a: 1, b: 2 })
})

test("extractJson survives fences and trailing prose", () => {
  assert.deepEqual(
    extractJson('```json\n{"a": 1}\n```\nLet me know if you need more.'),
    { a: 1 },
  )
})

test("extractJson does not stop at a brace inside a string", () => {
  const out = extractJson<{ reason: string; ok: boolean }>(
    '{"reason": "the filter } is missing", "ok": false}',
  )
  assert.equal(out.reason, "the filter } is missing")
  assert.equal(out.ok, false)
})

test("extractJson handles escaped quotes inside strings", () => {
  const out = extractJson<{ reason: string }>('{"reason": "cites \\"48.2M\\" rows"}')
  assert.match(out.reason, /48\.2M/)
})

test("extractJson error names the offending text so a failure is diagnosable", () => {
  assert.throws(() => extractJson("no object here"), /no JSON object/)
  assert.throws(() => extractJson('{"a": }'), /model output was/)
})
