import assert from "node:assert/strict";
import test from "node:test";
import { budgets } from "../config/budgets.ts";
import { sumUsd, VISUAL_TYPES, type ScenePlan, type ShotSpec, type VisualType } from "../contracts/index.ts";
import { scenePlanFixture } from "../contracts/fixtures/index.ts";
import { estimatePlan, UnknownPriceError } from "../budget/estimate.ts";
import { planTotals, REDO_ALLOWANCE_SHARE, shotCost, shotRoomUsd, usdAtMost } from "./cost.ts";
import { RECIPES } from "./tables.ts";

/** A one-shot ScenePlan for a type, built the way the planner's recipe says, so the budget module can price it. */
function singleShotPlan(visualType: VisualType, durationMs: number): ScenePlan {
  const recipe = RECIPES[visualType];
  const source: ShotSpec["source"] =
    recipe.kind === "generate"
      ? { kind: "generate", modelClass: recipe.modelClass, prompt: "A plain kitchen counter, no text in frame.", refs: [], takes: recipe.takes }
      : recipe.kind === "stock"
        ? { kind: "stock", query: "kitchen counter", minMs: durationMs }
        : { kind: "component", component: "fixture.component", props: {} };
  return {
    schema: "meridian.scene_plan/v1",
    planId: `plan_cost_${visualType}`,
    requestId: scenePlanFixture.requestId,
    videoDnaId: "dna_01KA0000000000000000000000",
    voiceTrackId: "vt_cost",
    shots: [
      {
        shotId: "shot_01KA0000000000000000000000",
        beatId: "b1",
        startMs: 0,
        endMs: durationMs,
        visualType,
        layer: "base",
        source,
        ...(recipe.kind === "generate" ? { downgradeTo: "kinetic_type" as const } : {}),
      },
    ],
    estimatedUsd: 0,
    decisions: [],
  };
}

test("the shot cost of every priced type equals the budget module's line for the same shot", () => {
  for (const visualType of VISUAL_TYPES) {
    const durationMs = 4000;
    const cost = shotCost(visualType, durationMs);
    if (!cost.known) {
      continue;
    }
    const estimate = estimatePlan(singleShotPlan(visualType, durationMs));
    assert.equal(cost.baseUsd, estimate.lines[0].estimateUsd, `${visualType} base cost`);
    assert.equal(cost.allowanceUsd, estimate.redoAllowanceUsd, `${visualType} allowance`);
    assert.equal(cost.totalUsd, sumUsd([estimate.lines[0].estimateUsd, estimate.redoAllowanceUsd]), `${visualType} total`);
  }
});

test("stop-motion has no known price (image.edit is token-priced), so it is unknown, never 0", () => {
  const cost = shotCost("stop_motion", 3000);
  assert.equal(cost.known, false);
  assert.throws(() => estimatePlan(singleShotPlan("stop_motion", 3000)), (error: unknown) => error instanceof UnknownPriceError);
});

function knownBase(visualType: VisualType, durationMs: number): number {
  const cost = shotCost(visualType, durationMs);
  assert.ok(cost.known, `${visualType} is priced`);
  return cost.baseUsd;
}

test("the cinematic and avatar figures match the Bible's catalogue, at 4 seconds", () => {
  // 7.1: cinematic $0.50 to $1.00 per 4 s (one take to two takes); ugc_presenter about $0.20 per 4 s.
  assert.equal(knownBase("cinematic", 4000), 1.008);
  assert.equal(knownBase("ugc_presenter", 4000), 0.2);
});

test("a generated shot carries the redo allowance; a component or stock shot does not", () => {
  assert.equal(REDO_ALLOWANCE_SHARE, budgets.redoAllowanceShare.value);
  const generated = shotCost("product_hero", 6000);
  assert.ok(generated.known);
  assert.equal(generated.allowanceUsd, 0.0504);
  assert.equal(generated.totalUsd, 0.252);
  const component = shotCost("coded_graphics", 6000);
  assert.ok(component.known);
  assert.equal(component.allowanceUsd, 0);
  assert.equal(component.totalUsd, 0);
});

test("plan totals follow estimatePlan's rounding: the allowance is on the summed generated cost", () => {
  const lines = [
    { baseUsd: 0.15, generated: true },
    { baseUsd: 0.2016, generated: true },
    { baseUsd: 0, generated: false },
  ];
  const totals = planTotals(lines);
  assert.equal(totals.shotsUsd, 0.3516);
  assert.equal(totals.generatedUsd, 0.3516);
  assert.equal(totals.allowanceUsd, 0.0879);
  assert.equal(totals.fixedUsd, 0.52);
  assert.equal(totals.reservedUsd, 0.9595);
});

test("the shot room is the request budget less the fixed lines, and never negative", () => {
  assert.equal(shotRoomUsd(4), 3.48);
  assert.equal(shotRoomUsd(0.5), 0, "a $0.50 budget leaves no room: the fixed lines are $0.52");
  assert.equal(shotRoomUsd(0), 0);
});

test("usdAtMost compares to 4 decimals, without float drift", () => {
  assert.equal(usdAtMost(0.1 + 0.2, 0.3), true);
  assert.equal(usdAtMost(0.3001, 0.3), false);
});
