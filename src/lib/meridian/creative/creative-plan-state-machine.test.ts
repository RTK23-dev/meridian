import assert from "node:assert/strict";
import test from "node:test";
import { transitionCreativePlanState } from "./state-machine.ts";

test("CreativePlan FSM: standard happy-path progression DRAFT -> READY_FOR_APPROVAL -> APPROVED -> EXECUTING -> COMPLETED", () => {
  const t1 = transitionCreativePlanState("draft", "ready_for_approval");
  assert.equal(t1.success, true);
  assert.equal(t1.newState, "ready_for_approval");

  const t2 = transitionCreativePlanState("ready_for_approval", "approved");
  assert.equal(t2.success, true);
  assert.equal(t2.newState, "approved");

  const t3 = transitionCreativePlanState("approved", "executing");
  assert.equal(t3.success, true);
  assert.equal(t3.newState, "executing");

  const t4 = transitionCreativePlanState("executing", "completed");
  assert.equal(t4.success, true);
  assert.equal(t4.newState, "completed");
});

test("CreativePlan FSM: idempotent approval returns clean no-op without error", () => {
  const result = transitionCreativePlanState("approved", "approved");
  assert.equal(result.success, true);
  assert.equal(result.alreadyInState, true);
  assert.equal(result.newState, "approved");
});

test("CreativePlan FSM: rejects approval transitions from illegal states", () => {
  // Cannot approve after execution has already started
  const tExec = transitionCreativePlanState("executing", "approved");
  assert.equal(tExec.success, false);
  assert.match(tExec.error || "", /Invalid transition/);

  // Cannot approve after plan was completed
  const tComp = transitionCreativePlanState("completed", "approved");
  assert.equal(tComp.success, false);
  assert.match(tComp.error || "", /terminal state/);

  // Cannot approve after rejection
  const tRej = transitionCreativePlanState("rejected", "approved");
  assert.equal(tRej.success, false);
  assert.match(tRej.error || "", /terminal state/);
});

test("CreativePlan FSM: guaranteed failure transitions", () => {
  // Executing to failed
  const tFail = transitionCreativePlanState("executing", "failed");
  assert.equal(tFail.success, true);
  assert.equal(tFail.newState, "failed");

  // Executing to partially_completed
  const tPartial = transitionCreativePlanState("executing", "partially_completed");
  assert.equal(tPartial.success, true);
  assert.equal(tPartial.newState, "partially_completed");

  // Approved to failed (pre-flight failure)
  const tPreFail = transitionCreativePlanState("approved", "failed");
  assert.equal(tPreFail.success, true);
  assert.equal(tPreFail.newState, "failed");
});

test("CreativePlan FSM: rejection branches from review states", () => {
  const tRej1 = transitionCreativePlanState("ready_for_approval", "rejected");
  assert.equal(tRej1.success, true);
  assert.equal(tRej1.newState, "rejected");

  const tRej2 = transitionCreativePlanState("awaiting_approval", "rejected");
  assert.equal(tRej2.success, true);
  assert.equal(tRej2.newState, "rejected");
});
