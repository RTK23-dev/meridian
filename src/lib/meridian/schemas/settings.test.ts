import assert from "node:assert/strict";
import test from "node:test";
import { memberInviteSchema, scoringWeightsSchema, workspaceNameSchema } from "./settings.ts";

test("workspace and invitation forms normalize valid values and reject invalid values", () => {
  assert.equal(workspaceNameSchema.parse({ name: "  Meridian  " }).name, "Meridian");
  assert.equal(workspaceNameSchema.safeParse({ name: " " }).success, false);
  assert.deepEqual(memberInviteSchema.parse({ email: "  TEAM@EXAMPLE.COM ", role: "member" }), { email: "team@example.com", role: "member" });
  assert.equal(memberInviteSchema.safeParse({ email: "invalid", role: "owner" }).success, false);
});

test("scoring weights reject blank and out-of-range values while parsing bounded numbers", () => {
  const fields = { brandFit: "1.25", historicalEvidence: "0", marketSignal: "2", novelty: "1", reproducibility: "0.5", saturation: "0", risk: "3" };
  const parsed = scoringWeightsSchema.parse(fields);
  assert.equal(parsed.brandFit, 1.25);
  assert.equal(scoringWeightsSchema.safeParse({ ...fields, risk: "" }).success, false);
  assert.equal(scoringWeightsSchema.safeParse({ ...fields, risk: "5.1" }).success, false);
});
