import assert from "node:assert/strict";
import test from "node:test";
import type { PlanStatus } from "../../engine/orchestrator/store.ts";
import { CREATE_STEPS, createStepFor } from "./steps.ts";

/** Every plan status, typed so that a status added to the engine fails the type check until it is listed here. */
const EVERY_STATUS: Record<PlanStatus, true> = {
  draft: true,
  planning: true,
  refused: true,
  ready: true,
  running: true,
  paused: true,
  incomplete: true,
  complete: true,
};

test("with no plan, Brief is current and Plan and Review are to do", () => {
  assert.deepEqual(createStepFor(null), { brief: "current", plan: "todo", review: "todo" });
});

test("a plan in draft has Brief done, Plan current and Review to do", () => {
  assert.deepEqual(createStepFor("draft"), { brief: "done", plan: "current", review: "todo" });
});

test("a plan in planning has Brief done, Plan current and Review to do", () => {
  assert.deepEqual(createStepFor("planning"), { brief: "done", plan: "current", review: "todo" });
});

test("a plan that was refused has Brief done, Plan current and Review to do", () => {
  assert.deepEqual(createStepFor("refused"), { brief: "done", plan: "current", review: "todo" });
});

test("a plan that is ready has Brief done, Plan current and Review to do", () => {
  assert.deepEqual(createStepFor("ready"), { brief: "done", plan: "current", review: "todo" });
});

test("a plan that is running has Brief done, Plan current and Review to do", () => {
  assert.deepEqual(createStepFor("running"), { brief: "done", plan: "current", review: "todo" });
});

test("a plan that is paused has Brief and Plan done and Review current", () => {
  assert.deepEqual(createStepFor("paused"), { brief: "done", plan: "done", review: "current" });
});

test("a plan that is incomplete has Brief and Plan done and Review current", () => {
  assert.deepEqual(createStepFor("incomplete"), { brief: "done", plan: "done", review: "current" });
});

test("a plan that is complete has Brief and Plan done and Review current", () => {
  assert.deepEqual(createStepFor("complete"), { brief: "done", plan: "done", review: "current" });
});

test("every plan status maps to a full set of Create steps, in the order of CREATE_STEPS", () => {
  for (const status of Object.keys(EVERY_STATUS) as PlanStatus[]) {
    assert.deepEqual(Object.keys(createStepFor(status)), [...CREATE_STEPS], status);
  }
});

test("a status this file does not know is treated as no plan, so no step is claimed as done", () => {
  const unknownStatus: string = "archived";
  assert.deepEqual(createStepFor(unknownStatus as PlanStatus), { brief: "current", plan: "todo", review: "todo" });
});
