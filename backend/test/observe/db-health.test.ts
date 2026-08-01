import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyOrigin,
  describeSpike,
  fillLatencyBuckets,
  markSpikes,
  truncateQuery,
  type RawLatencyRow,
} from "../../src/observe/db-health.js";

const HOUR = 3_600;

function raw(hourTs: number, p95Ms: number, queries = 10): RawLatencyRow {
  return { hourTs, p95Ms, queries, topKind: "Select", topRows: 0, topLogComment: "" };
}

// ── fillLatencyBuckets ───────────────────────────────────────────

test("an idle service still yields a dense 24-bucket series", () => {
  const buckets = fillLatencyBuckets([], Date.parse("2026-08-01T15:30:00Z"));
  assert.equal(buckets.length, 24);
  assert.ok(buckets.every((b) => b.p95Ms === 0 && b.queries === 0));
});

test("buckets are contiguous hours ending at the current hour", () => {
  const buckets = fillLatencyBuckets([], Date.parse("2026-08-01T15:30:00Z"));
  const last = buckets[23];
  const first = buckets[0];
  assert.equal(last?.hour, "2026-08-01T15:00:00.000Z");
  assert.equal(first?.hour, "2026-07-31T16:00:00.000Z");
  for (let i = 1; i < buckets.length; i++) {
    assert.equal((buckets[i]?.hourTs ?? 0) - (buckets[i - 1]?.hourTs ?? 0), HOUR);
  }
});

test("a measured hour lands in its own slot and the rest stay empty", () => {
  const nowMs = Date.parse("2026-08-01T15:30:00Z");
  const currentHour = Math.floor(nowMs / 3_600_000) * HOUR;
  const buckets = fillLatencyBuckets([raw(currentHour - 2 * HOUR, 144, 338)], nowMs);
  assert.equal(buckets[21]?.p95Ms, 144);
  assert.equal(buckets[21]?.queries, 338);
  assert.equal(buckets[22]?.p95Ms, 0);
});

test("rows outside the window are dropped rather than shifting the series", () => {
  const nowMs = Date.parse("2026-08-01T15:30:00Z");
  const currentHour = Math.floor(nowMs / 3_600_000) * HOUR;
  const buckets = fillLatencyBuckets([raw(currentHour - 48 * HOUR, 999)], nowMs);
  assert.equal(buckets.length, 24);
  assert.ok(buckets.every((b) => b.p95Ms === 0));
});

// ── markSpikes ───────────────────────────────────────────────────

test("a flat series flags nothing", () => {
  const nowMs = Date.parse("2026-08-01T15:30:00Z");
  const currentHour = Math.floor(nowMs / 3_600_000) * HOUR;
  const rows = Array.from({ length: 24 }, (_, i) => raw(currentHour - i * HOUR, 140));
  const marked = markSpikes(fillLatencyBuckets(rows, nowMs));
  assert.equal(marked.filter((b) => b.isSpike).length, 0);
});

test("a single outlier is flagged and carries a cause", () => {
  const nowMs = Date.parse("2026-08-01T15:30:00Z");
  const currentHour = Math.floor(nowMs / 3_600_000) * HOUR;
  const rows = Array.from({ length: 24 }, (_, i) => raw(currentHour - i * HOUR, 140));
  rows[5] = {
    hourTs: currentHour - 5 * HOUR,
    p95Ms: 4106,
    queries: 40,
    topKind: "Insert",
    topRows: 412_900,
    topLogComment: JSON.stringify({ app: "clickwright", agent: "instrumentation" }),
  };
  const marked = markSpikes(fillLatencyBuckets(rows, nowMs));
  const spikes = marked.filter((b) => b.isSpike);
  assert.equal(spikes.length, 1);
  assert.equal(spikes[0]?.p95Ms, 4106);
  assert.equal(spikes[0]?.spikeCause, "instrumentation insert (412,900 rows)");
});

test("an idle service does not report 4ms as an incident", () => {
  // Without the floor, 4ms against a 2ms median is "double" and would flag.
  const nowMs = Date.parse("2026-08-01T15:30:00Z");
  const currentHour = Math.floor(nowMs / 3_600_000) * HOUR;
  const rows = Array.from({ length: 24 }, (_, i) => raw(currentHour - i * HOUR, 2));
  rows[3] = raw(currentHour - 3 * HOUR, 8);
  const marked = markSpikes(fillLatencyBuckets(rows, nowMs));
  assert.equal(marked.filter((b) => b.isSpike).length, 0);
});

test("empty hours are never flagged as spikes", () => {
  const nowMs = Date.parse("2026-08-01T15:30:00Z");
  const currentHour = Math.floor(nowMs / 3_600_000) * HOUR;
  const marked = markSpikes(fillLatencyBuckets([raw(currentHour, 500, 3)], nowMs));
  assert.equal(marked.filter((b) => b.isSpike && b.queries === 0).length, 0);
});

test("describeSpike degrades gracefully with no attribution", () => {
  assert.equal(
    describeSpike({ hourTs: 0, p95Ms: 0, queries: 0, topKind: "Select", topRows: 0, topLogComment: "" }),
    "select",
  );
});

// ── classifyOrigin ───────────────────────────────────────────────

test("classifyOrigin separates base, agent-created and internal tables", () => {
  const base = new Set(["purchase_completed", "application_started"]);
  assert.equal(classifyOrigin("purchase_completed", base), "base");
  assert.equal(classifyOrigin("group_started", base), "agent");
  assert.equal(classifyOrigin("context_store", base), "internal");
  assert.equal(classifyOrigin("runs_log", base), "internal");
});

// ── truncateQuery ────────────────────────────────────────────────

test("truncateQuery collapses whitespace and bounds the length", () => {
  assert.equal(truncateQuery("SELECT\n  a,\n  b\nFROM t"), "SELECT a, b FROM t");
  const long = truncateQuery("x".repeat(500));
  assert.equal(long.length, 241);
  assert.ok(long.endsWith("…"));
});
