import assert from "node:assert/strict";
import test from "node:test";
import { APPROVABLE_STAGES, APPROVAL_LABELS, isApprovableStage, pendingApproval, runStatusLabel } from "./approval.ts";
import { FACTORY_GRAPH } from "./pipeline.ts";

test("every approvable stage is a stage of the factory line and has a label", () => {
  const lineStages = new Set(FACTORY_GRAPH.map((spec) => spec.type));
  for (const stage of APPROVABLE_STAGES) {
    assert.equal(lineStages.has(stage), true, `${stage} is on the factory line`);
    assert.ok(APPROVAL_LABELS[stage].startsWith("Approve"), `${stage} has an approve label`);
  }
});

test("only the four stages that spend, publish or commit a choice can be approved", () => {
  assert.equal(isApprovableStage("factory.produce"), true);
  assert.equal(isApprovableStage("factory.review"), true);
  assert.equal(isApprovableStage("factory.discover"), false);
  assert.equal(isApprovableStage("factory.gate"), false);
  assert.equal(isApprovableStage(""), false);
});

test("a run offers an approval only while it is awaiting approval at an approvable stage", () => {
  assert.equal(pendingApproval({ status: "awaiting_approval", stage: "factory.produce" }), "factory.produce");
  assert.equal(pendingApproval({ status: "awaiting_approval", stage: "factory.launch" }), "factory.launch");
  assert.equal(pendingApproval({ status: "awaiting_approval", stage: "factory.grade" }), null, "a step that is not approvable is never offered");
  assert.equal(pendingApproval({ status: "running", stage: "factory.produce" }), null);
  assert.equal(pendingApproval({ status: "paused", stage: "factory.produce" }), null, "a paused run needs its cap or kill switch, not an approval");
  assert.equal(pendingApproval({ status: "succeeded", stage: "factory.review" }), null);
});

test("run statuses read in plain words, and an unknown status is shown as stored", () => {
  assert.equal(runStatusLabel("awaiting_approval"), "Waiting for your approval");
  assert.equal(runStatusLabel("paused"), "Paused");
  assert.equal(runStatusLabel("succeeded"), "Finished");
  assert.equal(runStatusLabel("mystery"), "mystery");
});
