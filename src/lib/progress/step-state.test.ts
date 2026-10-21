import assert from "node:assert/strict";
import test from "node:test";
import { canJumpTo, nextStep, prevStep, stepStatuses } from "./step-state.ts";

const order = ["a", "b", "c", "d"];

test("a step is done, current or to do, from what is finished and where the person is", () => {
  const statuses = stepStatuses({ order: ["brief", "plan", "review"], current: "plan", done: ["brief"], dependsOn: {}, changed: [] });
  assert.deepEqual(statuses, { brief: "done", plan: "current", review: "todo" });
});

test("a finished step is stale when it depends on a changed step, directly or through another step", () => {
  const statuses = stepStatuses({ order, current: "d", done: ["a", "b", "c"], dependsOn: { b: ["a"], c: ["b"] }, changed: ["a"] });
  assert.deepEqual(statuses, { a: "done", b: "stale", c: "stale", d: "current" });
});

test("a finished step that does not depend on the change stays done, and the changed step itself stays done", () => {
  const statuses = stepStatuses({ order, current: "d", done: ["a", "b", "c"], dependsOn: { c: ["b"] }, changed: ["a"] });
  assert.deepEqual(statuses, { a: "done", b: "done", c: "done", d: "current" });
});

test("a step that is not finished is to do, even when what it depends on changed", () => {
  const statuses = stepStatuses({ order, current: "b", done: ["a"], dependsOn: { c: ["a"] }, changed: ["a"] });
  assert.deepEqual(statuses, { a: "done", b: "current", c: "todo", d: "todo" });
});

test("the current step is shown as current even when it is finished and would be stale", () => {
  const statuses = stepStatuses({ order, current: "b", done: ["a", "b"], dependsOn: { b: ["a"] }, changed: ["a"] });
  assert.equal(statuses.b, "current");
});

test("a dependency cycle ends, and ids that are not in the order are ignored", () => {
  const statuses = stepStatuses({
    order,
    current: "d",
    done: ["a", "b", "zzz"],
    dependsOn: { a: ["b"], b: ["a"], zzz: ["a"] },
    changed: ["a", "unknown"],
  });
  assert.deepEqual(statuses, { a: "stale", b: "stale", c: "todo", d: "current" });
});

test("a finished step or the current step can always be opened, and a later step cannot be opened before its earlier steps", () => {
  const state = { order: ["brief", "plan", "review"], done: ["brief"], current: "plan" };
  assert.equal(canJumpTo("brief", state), true);
  assert.equal(canJumpTo("plan", state), true);
  assert.equal(canJumpTo("review", state), false);
});

test("a step that is not finished can be opened only when every step before it is finished", () => {
  assert.equal(canJumpTo("b", { order, done: ["a"], current: "b" }), true);
  assert.equal(canJumpTo("c", { order, done: ["a"], current: "b" }), false);
  assert.equal(canJumpTo("d", { order, done: ["a"], current: "b" }), false);
  assert.equal(canJumpTo("c", { order, done: ["a", "b"], current: "b" }), true);
});

test("the first step can always be opened, and a step that is not in the order cannot", () => {
  assert.equal(canJumpTo("a", { order, done: [], current: "a" }), true);
  assert.equal(canJumpTo("zzz", { order, done: ["zzz"], current: "a" }), false);
});

test("nextStep and prevStep move one step along the order and stop at the ends", () => {
  assert.equal(nextStep("a", order), "b");
  assert.equal(nextStep("d", order), null);
  assert.equal(prevStep("c", order), "b");
  assert.equal(prevStep("a", order), null);
  assert.equal(nextStep("zzz", order), null);
  assert.equal(prevStep("zzz", order), null);
});
