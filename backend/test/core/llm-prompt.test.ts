import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPrompt } from "../../src/core/llm.js";

/** The placeholder guard exists to catch a prompt and its call site drifting
 * apart. It must not fire on what a user typed. */

test("a question containing braces does not trip the drift guard", async () => {
  const rendered = await loadPrompt("analytics_plan_tasks", {
    knowledge: "k",
    schemas: "s",
    history: "",
    question: "what does {{count}} mean?",
    feedback: "",
  });
  assert.ok(rendered.includes("{{count}}"), "the user's text reaches the model verbatim");
});

test("a genuinely missing variable still throws", async () => {
  await assert.rejects(
    () => loadPrompt("analytics_plan_tasks", { knowledge: "k" }),
    /unfilled placeholders/,
  );
});
