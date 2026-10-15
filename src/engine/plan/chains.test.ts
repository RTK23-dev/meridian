// Chains (contract v5, chains.ts): the calls of cartoon_generated and stop_motion, their prices, and the closing component. Every price
// here is a recorded list price from config/prices.ts, or a test overlay (test/priceOverlay.ts) that stands for the owner's price. No
// test calls a live API. The estimate is the budget module's (budget/estimate.ts), so the planner and the budget are checked to agree.

import assert from "node:assert/strict";
import test from "node:test";
import { roundUsd, type ScenePlan, type ShotSpec } from "../contracts/index.ts";
import {
  cartoonChainShotFixture,
  scenePlanFixture,
  stopMotionChainShotFixture,
  productKitFixture,
} from "../contracts/fixtures/index.ts";
import { estimatePlan, fixedBudgetLines, UnknownPriceError } from "../budget/estimate.ts";
import { prices } from "../config/prices.ts";
import { shotCost } from "./cost.ts";
import { filterCandidates } from "./filter.ts";
import {
  CHAIN_TYPES,
  callPriceOf,
  chainPriceOf,
  chainStepsOf,
  closingComponentProblem,
  frameOutputName,
  isChainType,
  stopMotionTiming,
} from "./chains.ts";
import { stopMotionChain } from "./sources.ts";
import { withPriceOverlay } from "./test/priceOverlay.ts";
import type { Candidate } from "./types.ts";

/** The price keys of the three routes the chains bill, read from the route table (never written out in a test). */
const KEYFRAME_KEY = prices.routeFor["image.keyframe"];
const CLIP_KEY = prices.routeFor["video.budget"];
const EDIT_KEY = prices.routeFor["image.edit"];

/** The owner's price for image.edit, as a test stands for it: per image (the unit a chain of frames bills), at a recorded figure. */
const OWNER_IMAGE_EDIT = { unit: "per_image", usd: 0.02, source: "list_oct_2026" } as const;

/** One shot as a plan, for the budget module to price. The shot's source is the given chain. */
function planWith(shot: ShotSpec): ScenePlan {
  return {
    ...scenePlanFixture,
    planId: `plan_chain_${shot.shotId}`,
    shots: [shot],
    estimatedUsd: 0,
    decisions: [],
  };
}

/** The shot lines of an estimate: every line except the fixed per-master lines, which the estimate appends last. */
function shotLinesOf(plan: ScenePlan) {
  const estimate = estimatePlan(plan);
  return estimate.lines.slice(0, estimate.lines.length - fixedBudgetLines().length);
}

test("the chain types are cartoon_generated and stop_motion, and only they are chains", () => {
  assert.deepEqual([...CHAIN_TYPES].sort(), ["cartoon_generated", "stop_motion"]);
  assert.equal(isChainType("cartoon_generated"), true);
  assert.equal(isChainType("stop_motion"), true);
  assert.equal(isChainType("cinematic"), false);
});

test("cartoon_generated is a keyframe call, then a video call (7.1); the output names are the ones the fixture chain reads", () => {
  const steps = chainStepsOf("cartoon_generated", 3000);
  assert.ok(steps.ok);
  if (!steps.ok) return;
  assert.deepEqual(steps.value, [
    { output: "keyframe", modelClass: "image.keyframe", takes: 1 },
    { output: "clip", modelClass: "video.budget", takes: 1 },
  ]);
  assert.equal(cartoonChainShotFixture.source.kind, "chain");
  const fixtureOutputs =
    cartoonChainShotFixture.source.kind === "chain"
      ? cartoonChainShotFixture.source.calls.map((call) => call.output)
      : [];
  assert.deepEqual(
    fixtureOutputs,
    steps.value.map((step) => step.output),
  );
});

test("stop_motion is 24 to 36 image.edit frames for a 2 to 4.5 second shot, named frame_01 to frame_NN, and refused outside that", () => {
  const steps = chainStepsOf("stop_motion", 2500);
  assert.ok(steps.ok);
  if (!steps.ok) return;
  assert.equal(steps.value.length, 30);
  assert.equal(steps.value[0]?.output, "frame_01");
  assert.equal(steps.value[29]?.output, "frame_30");
  assert.ok(steps.value.every((step) => step.modelClass === "image.edit" && step.takes === 1));
  assert.equal(
    chainStepsOf("stop_motion", 6000).ok,
    false,
    "a 6 second stop-motion shot has no frame count in the bounds",
  );
  assert.equal(frameOutputName(7), "frame_07");
  const short = stopMotionTiming(2000);
  assert.ok(short.ok);
  if (short.ok) assert.equal(short.value.frames, 24);
});

test("a call is priced by its route's price, billed as the estimate bills it (per second times the shot, per image per take)", () => {
  const keyframe = callPriceOf(
    { output: "keyframe", modelClass: "image.keyframe", takes: 1 },
    3000,
  );
  assert.deepEqual(keyframe, { known: true, routeKey: KEYFRAME_KEY, usd: 0.018 });
  const clip = callPriceOf({ output: "clip", modelClass: "video.budget", takes: 1 }, 3000);
  assert.deepEqual(clip, { known: true, routeKey: CLIP_KEY, usd: roundUsd(0.0336 * 3) });
});

test("the cartoon chain is priced as the sum of its two calls: 0.018 for the keyframe and 0.1008 for three seconds of video", () => {
  const chain = chainPriceOf("cartoon_generated", 3000);
  assert.deepEqual(chain, { known: true, routeKey: KEYFRAME_KEY, calls: 2, baseUsd: 0.1188 });
  const cost = shotCost("cartoon_generated", 3000);
  assert.ok(cost.known);
  if (!cost.known) return;
  assert.equal(cost.baseUsd, 0.1188);
  assert.equal(cost.generated, true);
  assert.equal(cost.calls, 2);
  assert.equal(
    cost.allowanceUsd,
    roundUsd(0.1188 * 0.25),
    "a chain carries the redo allowance, as a generated type does",
  );
});

test("the estimate prices every call of the cartoon chain, and its shot lines add up to the planner's cost", () => {
  const lines = shotLinesOf(planWith(cartoonChainShotFixture));
  assert.equal(lines.length, 2, "one budget line per call");
  assert.deepEqual(
    lines.map((line) => line.provider),
    [KEYFRAME_KEY, CLIP_KEY],
    "each line names the route key of its call",
  );
  const cost = shotCost("cartoon_generated", 3000);
  assert.ok(cost.known);
  if (!cost.known) return;
  const estimate = estimatePlan(planWith(cartoonChainShotFixture));
  assert.equal(
    estimate.shotsUsd,
    cost.baseUsd,
    "the estimate's shot total equals the planner's base cost for the chain",
  );
  assert.equal(
    estimate.redoAllowanceUsd,
    cost.allowanceUsd,
    "and its redo allowance equals the planner's",
  );
  assert.equal(
    estimate.shotsUsd,
    Math.round(lines.reduce((sum, line) => sum + line.estimateUsd, 0) * 10000) / 10000,
    "the sum of the calls",
  );
});

test("stop_motion is unknown while image.edit has no per-image price: refused with unknown_price, and the estimate refuses the plan", () => {
  const cost = shotCost("stop_motion", 2500);
  assert.equal(cost.known, false);
  if (cost.known) return;
  assert.match(cost.reason, new RegExp(`^unknown_price: ${EDIT_KEY} has no known price`));
  assert.match(cost.reason, /\(the chain makes 30 calls\)$/);
  assert.throws(
    () => estimatePlan(planWith(stopMotionChainShotFixture)),
    (error: unknown) => error instanceof UnknownPriceError,
  );
});

test("a price added to the table makes stop_motion priced: 30 frames at the owner's price, every frame a budget line", async () => {
  await withPriceOverlay({ [EDIT_KEY]: OWNER_IMAGE_EDIT }, () => {
    const cost = shotCost("stop_motion", 2500);
    assert.ok(cost.known);
    if (!cost.known) return;
    assert.equal(cost.routeKey, EDIT_KEY);
    assert.equal(cost.calls, 30);
    assert.equal(cost.baseUsd, 0.6, "30 frames at 0.02");
    assert.equal(cost.allowanceUsd, 0.15);
    const lines = shotLinesOf(planWith(stopMotionChainShotFixture));
    assert.equal(lines.length, 30, "one line per frame");
    assert.ok(lines.every((line) => line.provider === EDIT_KEY && line.estimateUsd === 0.02));
    assert.equal(
      estimatePlan(planWith(stopMotionChainShotFixture)).shotsUsd,
      cost.baseUsd,
      "the estimate equals the sum of the frames",
    );
  });
  assert.equal(prices.entries[EDIT_KEY].usd, null, "the overlay is restored after the run");
});

test("the overlay is restored even when the run throws, so no test sees another test's price", async () => {
  await assert.rejects(
    withPriceOverlay({ [EDIT_KEY]: OWNER_IMAGE_EDIT }, () => {
      throw new Error("the run failed");
    }),
    /the run failed/,
  );
  assert.equal(prices.entries[EDIT_KEY].usd, null);
});

test("the stop-motion chain the builder makes costs what its calls cost, frame for frame", async () => {
  const built = stopMotionChain({
    visualType: "stop_motion",
    prompt: "A small clay character hops beside the blender.",
    productKit: productKitFixture,
    claimIds: [],
    shot: {
      shotId: "shot_01JABCDEFGHJKMNPQRSTVWXYZ0",
      durationMs: 2500,
      beatRole: "item",
      showsProduct: true,
      words: ["a"],
      emphasis: [],
    },
  });
  assert.ok(built.ok);
  if (!built.ok) return;
  const shot: ShotSpec = {
    shotId: "shot_01JABCDEFGHJKMNPQRSTVWXYZ0",
    beatId: "b3",
    startMs: 0,
    endMs: 2500,
    visualType: "stop_motion",
    layer: "base",
    source: { kind: "chain", calls: built.value },
  };
  await withPriceOverlay({ [EDIT_KEY]: OWNER_IMAGE_EDIT }, () => {
    assert.equal(shotLinesOf(planWith(shot)).length, 30);
    assert.equal(estimatePlan(planWith(shot)).shotsUsd, 0.6);
  });
});

test("the closing component is named for stop_motion, and checked against the library the caller gives", () => {
  assert.equal(
    closingComponentProblem("cartoon_generated", () => false),
    null,
    "cartoon_generated has no closing component",
  );
  assert.equal(
    closingComponentProblem("product_hero", () => false),
    null,
  );
  assert.match(
    closingComponentProblem("stop_motion", () => false) ?? "",
    /closing component stopmotion\.player is not in the component library yet/,
  );
  assert.equal(
    closingComponentProblem("stop_motion", (name) => name === "stopmotion.player"),
    null,
  );
});

test("both sides at the filter: without a price stop_motion is removed by rule 5 (unknown_price); with one it is kept, because stopmotion.player is in the library", async () => {
  const kits = { persona: true, rigCharacter: true, generatedCharacter: true, productKit: true };
  const candidate: Candidate = { visualType: "stop_motion", origin: "proposal", proposalIndex: 0 };
  const input = {
    candidates: [candidate],
    kits,
    remainingUsd: 100,
    durationMs: 2500,
    mustAllowed: null,
    showsProduct: true,
    textInPixels: false,
    handsOnProduct: false,
  };
  const unpriced = filterCandidates(input);
  assert.equal(unpriced.kept.length, 0);
  assert.equal(unpriced.rejected[0]?.rule, "rule5_budget");
  assert.match(unpriced.rejected[0]?.detail ?? "", new RegExp(`^unknown_price: ${EDIT_KEY}`));
  await withPriceOverlay({ [EDIT_KEY]: OWNER_IMAGE_EDIT }, () => {
    // The player is drawn (merged from d1f532e), so rule 6 has nothing to remove: the price is the only gate left.
    assert.equal(closingComponentProblem("stop_motion"), null, "stopmotion.player is in the component library");
    const priced = filterCandidates(input);
    assert.equal(priced.rejected.length, 0, "rule 5 passes and no rule removes stop_motion");
    assert.deepEqual(
      priced.kept.map((kept) => kept.visualType),
      ["stop_motion"],
      "stop_motion is kept once image.edit has a price",
    );
  });
});

test("every chain type has a recorded price, or is unknown on purpose: no chain is priced at the calls it knows", () => {
  for (const visualType of CHAIN_TYPES) {
    const cost = shotCost(visualType, 2500);
    if (cost.known) {
      assert.ok(cost.baseUsd > 0, `${visualType} base cost is positive`);
    } else {
      assert.match(cost.reason, /^unknown_price:/, visualType);
    }
  }
});
