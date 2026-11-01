import { test } from "node:test";
import assert from "node:assert/strict";
import type { PlanNode } from "./contracts.ts";
import { holdUsdOf, measuredHoldUsd } from "./measure.ts";

const MEASURE = { ceilingUsdPerSecond: 0.5 };

function nodeOf(kind: PlanNode["kind"], params: PlanNode["params"], estimateUsd: number | null): PlanNode {
  return { id: "clip", kind, title: "clip", why: "a clip", dependsOn: [], model: null, params, estimateUsd };
}

test("a measured video is held to its ceiling times its length, rounded up", () => {
  assert.equal(measuredHoldUsd(nodeOf("video", { seconds: 8 }, null), MEASURE), 4);
  assert.equal(measuredHoldUsd(nodeOf("avatar", { seconds: 3.5 }, null), { ceilingUsdPerSecond: 0.1234 }), 0.4319);
});

test("the hold is null when measure mode is off, the step is not a video or avatar, or it has no usable length", () => {
  assert.equal(measuredHoldUsd(nodeOf("video", { seconds: 8 }, null), null), null, "measure mode is off");
  assert.equal(measuredHoldUsd(nodeOf("visual", { seconds: 8 }, null), MEASURE), null, "a still image is not measured");
  assert.equal(measuredHoldUsd(nodeOf("video", {}, null), MEASURE), null, "no length");
  assert.equal(measuredHoldUsd(nodeOf("video", { seconds: 0 }, null), MEASURE), null, "a zero length");
  assert.equal(
    measuredHoldUsd(nodeOf("video", { seconds: 8 }, null), { ceilingUsdPerSecond: 0 }),
    null,
    "a ceiling of zero would hold nothing, so the step does not run",
  );
});

test("a step's hold is its engine estimate, and measure mode applies only when it has none", () => {
  assert.equal(holdUsdOf(nodeOf("video", { seconds: 8 }, 1.28), MEASURE), 1.28, "an engine price is the hold");
  assert.equal(holdUsdOf(nodeOf("video", { seconds: 8 }, null), MEASURE), 4);
  assert.equal(holdUsdOf(nodeOf("video", { seconds: 8 }, null), null), null, "no price and no measure mode: the step does not run");
});
