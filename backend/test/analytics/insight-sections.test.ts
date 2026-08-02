import { test } from "node:test";
import assert from "node:assert/strict";
import { sectionsAreSubstantive } from "../../src/agents/analytics.js";

/**
 * The fast path past the LLM quality gate. It exists to catch the one failure
 * mode that needs no judgement: an answer whose "why" is its "what" reworded.
 * These tests care as much about what it lets past as what it rejects — a gate
 * that rejects honest answers teaches the narrator to invent causes.
 */
const base = {
  headline: "Android checkout conversion is 12.4%, less than half the 27.1% on iOS.",
  whatsHappening:
    "Of 8,314 Android sessions that reached pay-now, 1,033 completed a purchase — 12.4%, against 27.1% on iOS over the same window.",
  whyItHappens:
    "The gap concentrates entirely at OTP entry: Android sessions reach payment at the same rate as iOS but clear the OTP screen 18.7% of the time against 44.2%, which points at the SMS autofill path rather than at pricing or checkout design.",
  recommendedAction:
    "Instrument the OTP screen on Android before touching checkout copy — recovering even half the sessions lost there would close most of the gap.",
};

test("distinct sections pass", () => {
  assert.equal(sectionsAreSubstantive(base), true);
});

test("rejects a why that restates what's happening", () => {
  const restated = { ...base, whyItHappens: `${base.whatsHappening} That is the problem.` };
  assert.equal(sectionsAreSubstantive(restated), false);
});

test("rejects a why contained in what's happening", () => {
  const contained = {
    ...base,
    whatsHappening: `Some preamble. ${base.whyItHappens} And a trailing clause.`,
  };
  assert.equal(sectionsAreSubstantive(contained), false);
});

test("rejects a why too short to carry a mechanism", () => {
  assert.equal(sectionsAreSubstantive({ ...base, whyItHappens: "Android is worse." }), false);
});

test("rejects an action too vague to do", () => {
  assert.equal(sectionsAreSubstantive({ ...base, recommendedAction: "Investigate." }), false);
});

test("rejects any empty section", () => {
  assert.equal(sectionsAreSubstantive({ ...base, whatsHappening: "" }), false);
  assert.equal(sectionsAreSubstantive({ ...base, whyItHappens: "" }), false);
  assert.equal(sectionsAreSubstantive({ ...base, recommendedAction: "" }), false);
});

test("ignores case and punctuation when comparing sections", () => {
  const shouty = {
    ...base,
    whyItHappens: `${base.whatsHappening.toUpperCase()}!!! REALLY.`,
  };
  assert.equal(sectionsAreSubstantive(shouty), false);
});

test("an honest 'the data cannot explain this' still passes", () => {
  // refusing to guess a cause is a good answer and must not be graded as a
  // missing mechanism — otherwise the gate rewards inventing one
  const honest = {
    ...base,
    whyItHappens:
      "Platform, city and app version all move together within a couple of points, so nothing in the cuts available explains the fall; a session-level breakdown of the OTP screen would be needed to separate delivery failures from user abandonment.",
  };
  assert.equal(sectionsAreSubstantive(honest), true);
});
