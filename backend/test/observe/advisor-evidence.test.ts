import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stripDatabasePrefix,
  validateAgainstEvidence,
  type AdvisorEvidence,
  type ScanProposal,
} from "../../src/observe/advisor.js";

/**
 * `validateAgainstEvidence` is the gate between an LLM and a recommendation a
 * judge will read. The prompt asks the model to quote measured figures; a
 * hallucinated table name is the failure mode that would put a fabricated
 * suggestion — "drop the unused `user_sessions` table" — in front of them.
 */

function evidence(tables: string[]): AdvisorEvidence {
  return {
    windowHours: 24,
    totalBytes: 1_000_000,
    queryLogAvailable: true,
    tables: tables.map((table) => ({
      table,
      origin: "agent" as const,
      bytes: 1000,
      rows: 10,
      parts: 1,
      sharePct: 1,
      reads24h: 0,
      reads30d: 0,
    })),
    topShapes: [],
    materializedViews: [],
    oldestDataAgeHours: 48,
  };
}

function proposal(targets: Array<string | null>): ScanProposal {
  return {
    suggestions: targets.map((targetTable, i) => ({
      severity: "MED" as const,
      action: `do something measurable number ${i}`,
      why: "a reason long enough to satisfy the schema's minimum length rule",
      targetTable,
      actionable: true,
    })),
  };
}

test("suggestions about real tables pass", () => {
  validateAgainstEvidence(
    proposal(["purchase_completed", "auth_completed"]),
    evidence(["purchase_completed", "auth_completed", "search_typed"]),
  );
});

test("a hallucinated table name is rejected, and named in the error", () => {
  assert.throws(
    () => validateAgainstEvidence(proposal(["user_sessions"]), evidence(["auth_completed"])),
    (error: Error) => {
      assert.match(error.message, /user_sessions/);
      // The message is fed back to the model as retry feedback, so it has to
      // carry the valid names too.
      assert.match(error.message, /auth_completed/);
      return true;
    },
  );
});

test("database-wide suggestions carry no table and are always allowed", () => {
  // targetTable null is "this is about the database, not one table".
  validateAgainstEvidence(proposal([null]), evidence(["auth_completed"]));
  // An empty string is the same thing arriving from a stored row.
  validateAgainstEvidence(proposal([""]), evidence(["auth_completed"]));
});

test("every phantom is reported at once, deduplicated", () => {
  assert.throws(
    () =>
      validateAgainstEvidence(
        proposal(["ghost_a", "ghost_b", "ghost_a", "auth_completed"]),
        evidence(["auth_completed"]),
      ),
    (error: Error) => {
      const names = /do not exist: ([^.]+)\./.exec(error.message)?.[1] ?? "";
      // One retry should be able to fix all of them, so all of them are listed
      // — but "ghost_a, ghost_a" would waste feedback budget.
      assert.deepEqual(names.split(", "), ["ghost_a", "ghost_b"]);
      return true;
    },
  );
});

test("an empty database rejects every named table", () => {
  assert.throws(() => validateAgainstEvidence(proposal(["anything"]), evidence([])), /anything/);
});

// ── the qualified-name helper the read counts depend on ──────────

test("system.query_log's database-qualified names are stripped to bare tables", () => {
  assert.equal(stripDatabasePrefix("atlys_dataset.purchase_completed", "atlys_dataset"), "purchase_completed");
  // Another database's table keeps its prefix, so it cannot be mistaken for ours.
  assert.equal(stripDatabasePrefix("system.query_log", "atlys_dataset"), "system.query_log");
  assert.equal(stripDatabasePrefix("purchase_completed", "atlys_dataset"), "purchase_completed");
});
