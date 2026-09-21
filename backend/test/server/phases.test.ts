import { test } from "node:test";
import assert from "node:assert/strict";
import { nextTurnSeq, phaseOf, runPhaseOf } from "../../src/server/phases.js";

/**
 * These three functions decide what the two live streams look like: the phase
 * labels are the only thing a reader sees while an answer or a run is being
 * produced, and the turn sequence decides whether two questions asked at once
 * interleave. All pure — no database, no .env.
 */

// ── chat phases ──────────────────────────────────────────────────

test("every analytics step maps to a phase a reader can act on", () => {
  assert.equal(phaseOf("context_load"), "Reading the knowledge store");
  assert.equal(phaseOf("plan"), "Planning the analysis");
  assert.equal(phaseOf("plan_attempt_2"), "Planning the analysis");
  assert.equal(phaseOf("task_t1"), "Querying ClickHouse");
  assert.equal(phaseOf("sql_attempt_3"), "Querying ClickHouse");
  assert.equal(phaseOf("sanity_gate"), "Validating the results");
  assert.equal(phaseOf("narrate_attempt_1"), "Writing the insight");
  assert.equal(phaseOf("narrate_revision"), "Writing the insight");
});

test("the wrapper span and the cache probe stay off the timeline", () => {
  // "" is the signal the UI uses to skip a line entirely.
  assert.equal(phaseOf("analytics"), "");
  assert.equal(phaseOf("cache_lookup"), "");
});

test("confidence scores in the same phase as the quality gate", () => {
  // The cross-workstream hook: WS-C's new `confidence` step is the code-derived
  // half of "is this answer good enough", so it must not open a new phase line.
  assert.equal(phaseOf("confidence"), "Reviewing the answer");
  assert.equal(phaseOf("quality_gate"), "Reviewing the answer");
  assert.equal(phaseOf("quality_gate_attempt_2"), "Reviewing the answer");
});

test("an unknown chat step is still shown, as 'Working'", () => {
  // Chat must never render a blank row for a step that really ran.
  assert.equal(phaseOf("something_new"), "Working");
});

// ── run phases ───────────────────────────────────────────────────

test("run steps collapse onto the five pipeline phases", () => {
  assert.equal(runPhaseOf("profile"), "Profiling the events");
  assert.equal(runPhaseOf("context_load"), "Reading the knowledge store");
  assert.equal(runPhaseOf("schema_design_attempt_2"), "Designing the schema");
  assert.equal(runPhaseOf("ddl_generation_attempt_1"), "Designing the schema");
  assert.equal(runPhaseOf("dry_run"), "Validating the schema");
  assert.equal(runPhaseOf("approval_attempt_1"), "Waiting for your approval");
  assert.equal(runPhaseOf("ddl_execution_attempt_1"), "Creating tables and loading data");
  assert.equal(runPhaseOf("update_generation_attempt_1"), "Updating the knowledge store");
});

test("run wrappers and unknown steps surface nothing", () => {
  assert.equal(runPhaseOf("instrumentation"), "");
  assert.equal(runPhaseOf("optimization"), "");
  assert.equal(runPhaseOf("mystery_step"), "");
});

test("an optimization run's steps are phases, not blank lines", () => {
  // Optimization runs reuse the run stream but share no step names with spec
  // runs, so every one of their steps used to render as an unlabelled row.
  assert.equal(runPhaseOf("optimization_generation_attempt_1"), "Drafting the change");
  assert.equal(runPhaseOf("optimization_approval_attempt_1"), "Waiting for your approval");
  assert.equal(runPhaseOf("optimization_execution_attempt_2"), "Applying the change");
  // The wrapper span still surfaces nothing.
  assert.equal(runPhaseOf("optimization"), "");
});

// ── turn numbering ───────────────────────────────────────────────

test("a brand-new conversation starts at turn 0 so it gets titled", () => {
  // max(seq) over an empty set is 0 in ClickHouse, which is why count decides.
  assert.equal(nextTurnSeq(0, 0), 0);
});

test("each answered turn advances by two — user even, agent odd", () => {
  assert.equal(nextTurnSeq(2, 1), 2);
  assert.equal(nextTurnSeq(4, 3), 4);
  assert.equal(nextTurnSeq(12, 11), 12);
});

test("a second question asked mid-answer cannot land on the pending agent row", () => {
  // The first turn wrote user seq 0; its agent row (seq 1) is not written yet.
  // Reading max(seq) = 0 must still reserve 2, not overwrite the agent slot.
  assert.equal(nextTurnSeq(1, 0), 2);
  // Three questions deep with every answer still in flight.
  assert.equal(nextTurnSeq(2, 2), 4);
  assert.equal(nextTurnSeq(3, 4), 6);
});

test("a failed turn leaves a gap rather than flipping the parity", () => {
  // User row 0 persisted, the answer failed, so seq 1 never exists. The next
  // question must not reuse 1 — ordering is by seq, and a gap is harmless.
  assert.equal(nextTurnSeq(1, 0), 2);
});

test("junk counters degrade to a safe slot instead of NaN", () => {
  assert.equal(nextTurnSeq(Number.NaN, Number.NaN), 0);
  assert.equal(nextTurnSeq(3, Number.NaN), 2);
  assert.equal(nextTurnSeq(3, -5), 2);
});
