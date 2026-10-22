import { test } from "node:test";
import assert from "node:assert/strict";
import { splicePlanOf } from "./splice.ts";

const BEATS = [0, 2000, 4000, 6000, 8000, 10000];

test("a change inside the video re-renders its window, widened to the beats on each side, and keeps the rest", () => {
  const plan = splicePlanOf({ totalMs: 10000, changed: [{ startMs: 2500, endMs: 3600 }], beatBoundariesMs: BEATS });
  assert.equal(plan.status, "splice");
  if (plan.status !== "splice") return;
  assert.deepEqual(plan.window, { fromMs: 2000, toMs: 4000 });
  assert.deepEqual(plan.segments, [
    { kind: "keep", span: { fromMs: 0, toMs: 2000 } },
    { kind: "render", span: { fromMs: 2000, toMs: 4000 } },
    { kind: "keep", span: { fromMs: 4000, toMs: 10000 } },
  ]);
});

test("a change at the start keeps only what follows the window, and a change at the end keeps only what precedes it", () => {
  const start = splicePlanOf({ totalMs: 10000, changed: [{ startMs: 0, endMs: 1500 }], beatBoundariesMs: BEATS });
  assert.equal(start.status, "splice");
  if (start.status === "splice") assert.deepEqual(start.segments.map((segment) => segment.kind), ["render", "keep"]);
  const end = splicePlanOf({ totalMs: 10000, changed: [{ startMs: 8500, endMs: 10000 }], beatBoundariesMs: BEATS });
  assert.equal(end.status, "splice");
  if (end.status === "splice") assert.deepEqual(end.segments.map((segment) => segment.kind), ["keep", "render"]);
});

test("adjacent changed shots form one window, and a change that covers the whole video is a full render, with the reason", () => {
  const two = splicePlanOf({ totalMs: 10000, changed: [{ startMs: 2000, endMs: 4000 }, { startMs: 4000, endMs: 6000 }], beatBoundariesMs: BEATS });
  assert.equal(two.status, "splice");
  if (two.status === "splice") assert.deepEqual(two.window, { fromMs: 2000, toMs: 6000 });
  const whole = splicePlanOf({ totalMs: 10000, changed: [{ startMs: 0, endMs: 10000 }], beatBoundariesMs: BEATS });
  assert.deepEqual(whole, { status: "full", reason: "the changed shots cover the whole video, so nothing is kept" });
});

test("no changed shot is a full render with its reason, and the window never leaves the video", () => {
  assert.deepEqual(splicePlanOf({ totalMs: 10000, changed: [], beatBoundariesMs: BEATS }), { status: "full", reason: "no shot changed, so there is no window to render" });
  const late = splicePlanOf({ totalMs: 9000, changed: [{ startMs: 8000, endMs: 9000 }], beatBoundariesMs: [0, 4000, 9000, 12000] });
  assert.equal(late.status, "splice");
  if (late.status === "splice") assert.deepEqual(late.window, { fromMs: 4000, toMs: 9000 });
});
