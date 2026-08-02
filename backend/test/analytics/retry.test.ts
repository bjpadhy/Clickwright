import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { retryWithFeedback } from "../../src/agents/analytics.js";
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
