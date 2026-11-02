import assert from "node:assert/strict";
import { test } from "node:test";
import { nextStep, STEPS, type StepId } from "../web/src/tour.js";

const doneOf = (...ids: StepId[]) =>
  Object.fromEntries(STEPS.map((s) => [s.id, ids.includes(s.id)])) as Record<
    StepId,
    boolean
  >;

test("the tour moves forward and ends; skipping the last step never jumps back", () => {
  // The tester's run: everything but the review done, then "Change the policy" skipped.
  const done = doneOf("signin", "policy", "small", "large", "audit");
  assert.equal(nextStep(done, [])?.id, "change");
  assert.equal(nextStep(done, ["change"]), undefined);
  // From the start, skipping a step moves to the one after it.
  assert.equal(nextStep(doneOf("signin"), [])?.id, "policy");
  assert.equal(nextStep(doneOf("signin"), ["policy"])?.id, "small");
  // All done: finished.
  assert.equal(nextStep(doneOf(...STEPS.map((s) => s.id)), []), undefined);
});
