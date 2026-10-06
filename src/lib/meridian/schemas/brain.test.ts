import assert from "node:assert/strict";
import test from "node:test";
import { emptyBrain } from "../brain.ts";
import { brainValuesSchema } from "./brain.ts";

test("brain schema trims fields and accepts the supported automation levels", () => {
  const brain = emptyBrain();
  brain.positioning = "  Thoughtful positioning  ";
  brain.automationLevel = "assisted";

  const parsed = brainValuesSchema.parse(brain);
  assert.equal(parsed.positioning, "Thoughtful positioning");
  assert.equal(parsed.automationLevel, "assisted");
});

test("brain schema rejects overlong fields and unknown automation levels", () => {
  const brain = emptyBrain();
  brain.tone = "x".repeat(4001);
  assert.equal(brainValuesSchema.safeParse(brain).success, false);

  const invalidLevel = { ...emptyBrain(), automationLevel: "hands-off" };
  assert.equal(brainValuesSchema.safeParse(invalidLevel).success, false);
});
