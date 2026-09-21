import { test } from "node:test";
import assert from "node:assert/strict";
import { sanityGate } from "../../src/agents/analytics.js";

/**
 * The sanity gate feeds confidence, so it has to COUNT, not just describe.
 * `sanityFlags = notes.length` conflated three different things — drops, blocked
 * queries and real anomalies — and dropped tasks were counted twice, once here
 * and again at the call site. `counts` is the fix: one number per kind, each
 * task counted once.
 *
 * The small-sample check is the other repair. It used a PREFIX regex
 * (`/^(n|count|total|…)/`) while the SQL naming convention mandates `_n`
 * SUFFIXES, so "all sample sizes below 50" almost never fired on the results it
 * was written for.
 */

type Results = Parameters<typeof sanityGate>[0];
type Result = Results[number];

/** A task result as the pipeline hands it to the gate. */
function taskResult(over: Partial<Result> & { id: string; rows: Record<string, unknown>[] }): Result {
  const sql = `SELECT * FROM ${over.id}`;
  return {
    title: `task ${over.id}`,
    sql,
    semanticSql: sql,
    coreSql: sql,
    authoredLimit: null,
    totalRows: over.rows.length,
    digest: null,
    digestNote: "",
    flags: [],
    ...over,
  } as Result;
}

test("suffix-named sample sizes all below 50 raise the small-sample flag", () => {
  const { kept, notes, counts } = sanityGate([
    taskResult({
      id: "t1",
      rows: [
        { os: "ios", apply_rate: 0.4, applied_n: 12 },
        { os: "android", apply_rate: 0.5, applied_n: 31 },
      ],
    }),
  ]);
  assert.equal(kept.length, 1);
  assert.equal(counts.smallSample, 1);
  assert.equal(counts.impossible, 0);
  assert.equal(counts.dropped, 0);
  assert.ok(
    notes.some((note) => /below 50/.test(note)),
    `expected a small-sample note, got ${JSON.stringify(notes)}`,
  );
});

test("one sample size at or above 50 clears the flag", () => {
  const { counts } = sanityGate([
    taskResult({
      id: "t1",
      rows: [
        { apply_rate: 0.4, applied_n: 12 },
        { apply_rate: 0.5, applied_n: 900 },
      ],
    }),
  ]);
  assert.equal(counts.smallSample, 0);
});

test("an empty result is dropped and counted exactly once", () => {
  const { kept, notes, counts } = sanityGate([
    taskResult({ id: "t1", rows: [], totalRows: 0 }),
    taskResult({ id: "t2", rows: [{ apply_rate: 0.4, applied_n: 900 }] }),
  ]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.id, "t2");
  assert.equal(counts.dropped, 1, "an empty result is ONE dropped task, not two");
  assert.equal(notes.filter((note) => /t1/.test(note)).length, 1, "and it produces ONE note");
});

test("a blocked query is dropped with the writer's reason, counted once", () => {
  const { kept, notes, counts } = sanityGate([
    taskResult({
      id: "t1",
      rows: [{ blocked: 1, reason: "no coupon column on this table" }],
    }),
  ]);
  assert.equal(kept.length, 0);
  assert.equal(counts.dropped, 1);
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /no coupon column on this table/);
});

test("a rate above 100% is an impossible value, not a dropped task", () => {
  const { kept, notes, counts } = sanityGate([
    taskResult({ id: "t1", rows: [{ applied_rate: 1.2, applied_n: 900 }] }),
  ]);
  assert.equal(kept.length, 1, "the task is kept — the figure is flagged, not discarded");
  assert.equal(counts.impossible, 1);
  assert.equal(counts.dropped, 0);
  assert.ok(notes.some((note) => /above 100%/.test(note)));
});

test("a count above 1 is not mistaken for a rate above 100%", () => {
  // "share_clicked_applications" is a count; matching "share" inside it once
  // flagged 1,601 as a rate above 100%.
  const { counts } = sanityGate([
    taskResult({ id: "t1", rows: [{ share_clicked_applications: 1601, applied_n: 900 }] }),
  ]);
  assert.equal(counts.impossible, 0);
});

test("a clean result produces no notes and no counts", () => {
  const { kept, notes, counts } = sanityGate([
    taskResult({ id: "t1", rows: [{ apply_rate: 0.42, applied_n: 848 }] }),
  ]);
  assert.equal(kept.length, 1);
  assert.deepEqual(notes, []);
  assert.deepEqual(counts, { impossible: 0, smallSample: 0, dropped: 0 });
});

test("counts add up across tasks, each task contributing at most one of each", () => {
  const { counts } = sanityGate([
    taskResult({ id: "t1", rows: [] }),
    taskResult({ id: "t2", rows: [{ blocked: 1, reason: "not computable" }] }),
    taskResult({ id: "t3", rows: [{ a_rate: 1.2, b_rate: 1.4, applied_n: 900 }] }),
    taskResult({ id: "t4", rows: [{ apply_rate: 0.3, applied_n: 9 }] }),
  ]);
  assert.equal(counts.dropped, 2);
  assert.equal(counts.smallSample, 1);
  assert.ok(counts.impossible >= 1, "at least the task with impossible rates is counted");
});
