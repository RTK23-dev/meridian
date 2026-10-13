import assert from "node:assert/strict";
import test from "node:test";
import { BRAIN_FIELDS, REQUIRED_BRAIN_KEYS, type BrainKey } from "../../lib/meridian/brain.ts";
import { FIELD_GUIDE, brainFieldAnchor, brainSetupSteps, nextBrainStep } from "./brain-guide.ts";

test("every brain field says what to write and gives a placeholder example", () => {
  for (const field of BRAIN_FIELDS) {
    const guide = FIELD_GUIDE[field.key];
    assert.ok(guide, `${field.key} has guidance`);
    assert.ok(guide.help.trim().length > 0, `${field.key} has help text`);
    assert.ok(guide.example.startsWith("For example"), `${field.key} example is labelled as an example`);
  }
  assert.equal(Object.keys(FIELD_GUIDE).length, BRAIN_FIELDS.length, "no guidance for a field that does not exist");
});

test("the setup steps are the four required fields, in form order, each linking to its field", () => {
  const steps = brainSetupSteps({});
  assert.deepEqual(steps.map((step) => step.key), [...REQUIRED_BRAIN_KEYS]);
  assert.deepEqual(steps.map((step) => step.section), ["positioning", "audience", "voice", "rules"]);
  assert.deepEqual(steps.map((step) => step.anchor), REQUIRED_BRAIN_KEYS.map((key) => brainFieldAnchor(key)));
  assert.equal(brainFieldAnchor("targetCustomers"), "brain-field-targetCustomers");
});

test("an empty brain starts at the first required field, and the rest wait", () => {
  const steps = brainSetupSteps({});
  assert.equal(steps[0]!.state, "current");
  assert.deepEqual(steps.slice(1).map((step) => step.state), ["upcoming", "upcoming", "upcoming"]);
  assert.equal(nextBrainStep({})?.key, "positioning");
});

test("a whitespace-only required field is still open, and the next step moves on as fields fill", () => {
  assert.equal(nextBrainStep({ positioning: "   " })?.key, "positioning");
  const afterFirst = brainSetupSteps({ positioning: "A gentle wash for families." });
  assert.deepEqual(afterFirst.map((step) => step.state), ["done", "current", "upcoming", "upcoming"]);
  assert.equal(nextBrainStep({ positioning: "A gentle wash for families." })?.key, "targetCustomers");
});

test("a later field filled before an earlier one does not skip the earlier one", () => {
  const steps = brainSetupSteps({ tone: "warm, calm" });
  assert.deepEqual(steps.map((step) => step.state), ["current", "upcoming", "done", "upcoming"]);
  assert.equal(nextBrainStep({ tone: "warm, calm" })?.key, "positioning");
});

test("a brain with all four required fields has no next step", () => {
  const full: Partial<Record<BrainKey, string>> = {
    positioning: "p",
    targetCustomers: "t",
    tone: "warm",
    prohibitedClaims: "cures",
  };
  assert.equal(nextBrainStep(full), null);
  assert.ok(brainSetupSteps(full).every((step) => step.done && step.state === "done"));
});
