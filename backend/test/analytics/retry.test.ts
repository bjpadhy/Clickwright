import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { PlanSchema, retryWithFeedback } from "../../src/agents/analytics.js";
import { loadPrompt } from "../../src/core/llm.js";
import { phaseOf } from "../../src/server/chat.js";

/**
 * The self-healing contract for the plan and quality-gate steps: a failed parse
 * becomes feedback for the next attempt instead of a dead run, and exhaustion is
 * the call site's decision — the plan throws, the advisory gate degrades.
 */

test("returns the first successful result without further attempts", async () => {
  let attempts = 0;
  const result = await retryWithFeedback(
    3,
    async () => {
      attempts++;
      return "ok";
    },
    () => {
      throw new Error("should not be reached");
    },
  );
  assert.equal(result, "ok");
  assert.equal(attempts, 1);
});

test("feeds the previous attempt's error into the next attempt as feedback", async () => {
  const seen: string[] = [];
  const result = await retryWithFeedback(
    3,
    async (feedback) => {
      seen.push(feedback);
      if (seen.length === 1) throw new Error("the JSON was cut off");
      return "recovered";
    },
    () => {
      throw new Error("should not be reached");
    },
  );
  assert.equal(result, "recovered");
  assert.equal(seen[0], "");
  assert.match(seen[1]!, /the JSON was cut off/);
});

test("humanizes a ZodError into field-level feedback the model can act on", async () => {
  const QualityLike = z.object({ verdict: z.enum(["pass", "revise"]) });
  const zodError = QualityLike.safeParse({ verdict: "maybe" }).error!;
  const seen: string[] = [];
  await retryWithFeedback(
    2,
    async (feedback) => {
      seen.push(feedback);
      if (seen.length === 1) throw zodError;
      return null;
    },
    () => null,
  );
  // named field in words, not a raw issue dump — plus the re-read instruction
  assert.match(seen[1]!, /verdict/);
  assert.match(seen[1]!, /Re-read the "Output" section/);
});

test("hands the last feedback to onExhausted after every attempt fails", async () => {
  let exhaustedWith = "";
  const result = await retryWithFeedback(
    3,
    async (_feedback, attempt) => {
      throw new Error(`attempt ${attempt} failed`);
    },
    (feedback) => {
      exhaustedWith = feedback;
      return "degraded";
    },
  );
  assert.equal(result, "degraded");
  assert.match(exhaustedWith, /attempt 3 failed/);
});

test("propagates a throw from onExhausted (the plan's fail-loudly case)", async () => {
  await assert.rejects(
    retryWithFeedback(
      2,
      async () => {
        throw new Error("malformed");
      },
      (feedback) => {
        throw new Error(`planning failed schema checks: ${feedback}`);
      },
    ),
    /planning failed schema checks: malformed/,
  );
});

// ── prompt templates carry the feedback into the model's context ──

test("analytics_plan_tasks renders retry feedback into the prompt", async () => {
  const rendered = await loadPrompt("analytics_plan_tasks", {
    knowledge: "K",
    schemas: "S",
    history: "H",
    question: "Q",
    feedback: "FEEDBACK_MARKER_7291",
  });
  assert.match(rendered, /FEEDBACK_MARKER_7291/);
});

test("analytics_verify_query renders the result's column names into the prompt", async () => {
  // `expected_to_match` naming a column that is not in the result was the single
  // largest cause of inconclusive verifications, so the names are handed to the
  // auditor explicitly — and loadPrompt throws if the call site forgets one.
  const rendered = await loadPrompt("analytics_verify_query", {
    question: "Q",
    task: "T",
    sql: "SELECT 1",
    result: "[]",
    columns: JSON.stringify(["full_applied_rate", "full_applied_n"]),
    digest: "D",
    definitions: "DEF",
    schemas: "S",
  });
  assert.match(rendered, /<their_columns>/);
  assert.match(rendered, /full_applied_rate/);
  assert.match(rendered, /expected_to_match` is one of the names in <their_columns>, copied exactly/);
});

test("analytics_review_quality renders retry feedback into the prompt", async () => {
  const rendered = await loadPrompt("analytics_review_quality", {
    question: "Q",
    insight: "{}",
    results: "R",
    feedback: "FEEDBACK_MARKER_4418",
  });
  assert.match(rendered, /FEEDBACK_MARKER_4418/);
});

// ── the chat UI keeps its phase labels for per-attempt spans ──

test("plan attempt spans map to the planning phase", () => {
  assert.equal(phaseOf("plan_attempt_1"), "Planning the analysis");
  assert.equal(phaseOf("plan_attempt_3"), "Planning the analysis");
});

test("quality gate attempt spans map to the review phase", () => {
  assert.equal(phaseOf("quality_gate_attempt_2"), "Reviewing the answer");
});

// ── the plan schema cannot fail on `assumptions` alone ──────────
// Exhausting the plan retries THROWS, so a field the prompt never specifies must
// never be able to reject: a 121-character assumption, or a seventh one, would
// kill a question that worked before the field existed.

test("an over-long or over-full assumptions list is clamped, never rejected", () => {
  const long = "x".repeat(400);
  const plan = PlanSchema.parse({
    approach: "a",
    tasks: [{ id: "t1", title: "t", question: "q", tables: ["events"] }],
    assumptions: [long, ...Array.from({ length: 9 }, (_, i) => `assumption ${i}`)],
  });
  assert.equal(plan.assumptions.length, 6, "clamped to six, not rejected");
  assert.equal(plan.assumptions[0]!.length, 120, "each one truncated to 120 chars");
});

test("assumptions the planner writes badly degrade to none rather than killing the plan", () => {
  const base = {
    approach: "a",
    tasks: [{ id: "t1", title: "t", question: "q", tables: ["events"] }],
  };
  for (const assumptions of [undefined, [], ["  ", "", "  kept  "], "not an array", [1, 2], null]) {
    const parsed = PlanSchema.parse({ ...base, assumptions });
    assert.ok(Array.isArray(parsed.assumptions), String(assumptions));
    assert.ok(parsed.assumptions.every((a) => a.length > 0), String(assumptions));
  }
  // blanks are dropped and the survivors trimmed
  assert.deepEqual(
    PlanSchema.parse({ ...base, assumptions: ["  ", "", "  last 90 days  "] }).assumptions,
    ["last 90 days"],
  );
});

test("depends_on is still a hard check the retry loop can turn into feedback", () => {
  assert.throws(
    () =>
      PlanSchema.parse({
        approach: "a",
        tasks: [
          { id: "t1", title: "t", question: "q", tables: ["events"] },
          { id: "t2", title: "t", question: "q", tables: ["events"], depends_on: "t9" },
        ],
      }),
    /depends_on/,
  );
});
