import { test } from "node:test";
import assert from "node:assert/strict";
import { evictableRuns, type EvictableRun } from "../../src/server/runs.js";

const NOW = Date.parse("2026-08-01T15:00:00.000Z");
const GRACE = 60_000;

function run(
  id: string,
  createdMsAgo: number,
  status: EvictableRun["status"],
  finishedMsAgo: number | null = null,
): EvictableRun {
  return {
    id,
    status,
    createdAt: new Date(NOW - createdMsAgo).toISOString(),
    finishedAt: finishedMsAgo === null ? null : new Date(NOW - finishedMsAgo).toISOString(),
  };
}

test("nothing is evicted while the map is within the cap", () => {
  const runs = [run("a", 10_000, "succeeded", 5_000), run("b", 5_000, "running")];
  assert.deepEqual(evictableRuns(runs, 40, NOW, GRACE), []);
});

test("the run that just finished is never evicted, even as the oldest", () => {
  // 41 runs posted in one burst: run #1 is the oldest by createdAt AND the
  // first to complete. Evicting it 404s /api/runs/:id the moment it finishes.
  const runs = [
    run("first", 60_000, "succeeded", 10),
    ...Array.from({ length: 40 }, (_, i) => run(`q${i}`, 59_000 - i, "queued")),
  ];
  const evicted = evictableRuns(runs, 40, NOW, GRACE);
  assert.deepEqual(evicted, []);
});

test("past the grace window the oldest-finished run goes first", () => {
  const runs = [
    run("stale", 10 * 60_000, "succeeded", 9 * 60_000),
    run("older-created-newer-finished", 20 * 60_000, "failed", 2 * 60_000),
    run("fresh", 60_000, "succeeded", 10),
    run("busy", 30_000, "running"),
  ];
  const evicted = evictableRuns(runs, 3, NOW, GRACE);
  assert.deepEqual(evicted.map((r) => r.id), ["stale"]);
});

test("queued, running and gated runs are never candidates", () => {
  const runs = [
    run("q", 10 * 60_000, "queued"),
    run("r", 9 * 60_000, "running"),
    run("g", 8 * 60_000, "awaiting_approval"),
    run("done", 7 * 60_000, "succeeded", 6 * 60_000),
  ];
  assert.deepEqual(
    evictableRuns(runs, 1, NOW, GRACE).map((r) => r.id),
    ["done"],
  );
});

test("a terminal run with no finishedAt falls back to its creation time", () => {
  const runs = [
    run("nofinish", 10 * 60_000, "failed", null),
    run("recent", 60_000, "succeeded", 30 * 1000),
    run("other", 30_000, "running"),
  ];
  assert.deepEqual(
    evictableRuns(runs, 2, NOW, GRACE).map((r) => r.id),
    ["nofinish"],
  );
});
