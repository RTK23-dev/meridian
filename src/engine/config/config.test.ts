import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_CLASSES } from "../contracts/plan.ts";
import { EngineError, sumUsd } from "../contracts/index.ts";
import { budgets } from "./budgets.ts";
import { CONTRACTS_VERSION } from "../contracts/version.ts";
import { prices, priceFor, type PriceKey } from "./prices.ts";
import { routes, type Capability } from "./routes.ts";
import { thresholds } from "./thresholds.ts";
import { clampTunable, tunable, type Tunable } from "./tunable.ts";
import { weights } from "./weights.ts";

/** Every Tunable object reachable from a config object, with its path, for the bounds test. */
function collectTunables(node: unknown, path: string, out: [string, Tunable][]): void {
  if (node === null || typeof node !== "object") {
    return;
  }
  const candidate = node as Partial<Tunable>;
  if (typeof candidate.value === "number" && typeof candidate.floor === "number" && typeof candidate.ceiling === "number") {
    out.push([path, candidate as Tunable]);
    return;
  }
  for (const [key, child] of Object.entries(node)) {
    collectTunables(child, `${path}.${key}`, out);
  }
}

test("every Tunable in the config has floor <= value <= ceiling", () => {
  const found: [string, Tunable][] = [];
  collectTunables(thresholds, "thresholds", found);
  collectTunables(weights, "weights", found);
  collectTunables(budgets, "budgets", found);
  assert.ok(found.length >= 30, `expected many tunables, found ${found.length}`);
  for (const [path, value] of found) {
    assert.ok(value.floor <= value.value && value.value <= value.ceiling, `${path} is outside its bounds`);
    assert.ok(Number.isFinite(value.value), `${path} is not finite`);
  }
});

test("each config file carries its version string", () => {
  assert.equal(thresholds.version, "thresholds@1");
  assert.equal(weights.version, "weights@1");
  assert.equal(prices.version, "prices@2");
  assert.equal(budgets.version, "budgets@1");
});

test("the contract set is at version 2 (LedgerEntry role fields and VoiceKit wordsPerMinute, E2)", () => {
  assert.equal(CONTRACTS_VERSION, "engine-contracts@2");
});

test("tunable refuses an initial value outside its own bounds", () => {
  assert.throws(() => tunable(2, 0, 1), EngineError);
  assert.throws(() => tunable(-1, 0, 1), EngineError);
  assert.throws(() => tunable(0.5, Number.NaN, 1), EngineError);
  assert.deepEqual(tunable(0.5, 0, 1), { value: 0.5, floor: 0, ceiling: 1 });
});

test("clampTunable limits the move from the current value to 15 per cent by default", () => {
  const current = tunable(0.5, 0, 1);
  assert.equal(clampTunable(0.9, current), 0.575);
  assert.equal(clampTunable(0.1, current), 0.425);
  assert.equal(clampTunable(0.52, current), 0.52);
});

test("clampTunable holds the result inside the floor and the ceiling", () => {
  const nearTop = tunable(0.95, 0.5, 0.96);
  assert.equal(clampTunable(2, nearTop), 0.96);
  const nearBottom = tunable(0.52, 0.5, 1);
  assert.equal(clampTunable(-5, nearBottom), 0.5);
});

test("clampTunable never moves more than the allowed share, for any proposal", () => {
  const current = tunable(0.3, 0, 1);
  for (let i = 0; i <= 100; i++) {
    const next = clampTunable(i / 50 - 1, current);
    assert.ok(Math.abs(next - current.value) <= 0.3 * 0.15 + 1e-12, `moved to ${next}`);
  }
});

test("clampTunable keeps the current value for a non-finite proposal (fail closed)", () => {
  const current = tunable(0.6, 0.3, 0.9);
  assert.equal(clampTunable(Number.NaN, current), 0.6);
  assert.equal(clampTunable(Number.POSITIVE_INFINITY, current), 0.6);
});

test("clampTunable accepts a custom share and refuses a share outside 0 to 1", () => {
  const current = tunable(0.5, 0, 1);
  assert.equal(clampTunable(1, current, 0.1), 0.55);
  assert.equal(clampTunable(1, current, 0), 0.5);
  assert.throws(() => clampTunable(1, current, 1.5), EngineError);
  assert.throws(() => clampTunable(1, current, -0.1), EngineError);
});

test("the Bible 7.5 visual-type weights and the 10.2 provider weights have their initial values", () => {
  assert.equal(weights.visualScore.beatFit.value, 0.3);
  assert.equal(weights.visualScore.referenceMatch.value, 0.2);
  assert.equal(weights.visualScore.styleFit.value, 0.15);
  assert.equal(weights.visualScore.winRate.value, 0.15);
  assert.equal(weights.visualScore.costShare.value, 0.1);
  assert.equal(weights.visualScore.artifactRisk.value, 0.1);
  assert.equal(weights.visualScore.continuity.value, 0.05);
  assert.equal(weights.visualScore.repetition.value, 0.05);
  assert.equal(weights.winRatePrior.value, 0.5);
  assert.equal(weights.winRateMinSamples, 30);
});

test("the 10.2 provider weights sum to 1.00 in their initial values", () => {
  const sum = Object.values(weights.providerScore).reduce((total, t) => total + t.value, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `provider weights sum to ${sum}`);
});

test("the Bible 12 gate thresholds have their initial values", () => {
  assert.equal(thresholds.escalation.criticConfidence.value, 0.6);
  assert.equal(thresholds.take.durationTolerance.value, 0.1);
  assert.equal(thresholds.take.flickerMax.value, 0.25);
  assert.equal(thresholds.take.motionMin.value, 0.05);
  assert.equal(thresholds.take.productMatchMin.value, 0.85);
  assert.equal(thresholds.take.personaMatchMin.value, 0.8);
  assert.equal(thresholds.take.paletteShareMin.value, 0.7);
  assert.equal(thresholds.take.slopRubricItemMin.value, 0.7);
  assert.equal(thresholds.voice.wordErrorRateMax.value, 0.03);
  assert.equal(thresholds.postRender.slideshowRiskMax.value, 0.35);
  assert.equal(thresholds.postRender.loudnessTargetLufs, -14);
  assert.equal(thresholds.postRender.truePeakMaxDbtp, -1);
  assert.equal(thresholds.postRender.silenceMaxMs.value, 700);
  assert.equal(thresholds.postRender.captionTimingToleranceMs.value, 150);
  assert.equal(thresholds.render.durationToleranceMs.value, 100);
});

test("the Bible 8.3 EDL rules and the 10.4 concurrency and breaker numbers have their initial values", () => {
  assert.equal(thresholds.edit.shotLengthMinMs, 400);
  assert.equal(thresholds.edit.shotLengthMaxMs, 6000);
  assert.equal(thresholds.edit.captionWordsMin, 1);
  assert.equal(thresholds.edit.captionWordsMax, 3);
  assert.deepEqual(thresholds.edit.safeZoneShare, { top: 0.1, bottom: 0.2, right: 0.12 });
  assert.equal(thresholds.edit.sameShotTypeMaxRun, 3);
  assert.deepEqual(thresholds.router.concurrency, { video: 10, image: 20, tts: 30 });
  assert.equal(thresholds.router.breaker.failureShare, 0.3);
  assert.equal(thresholds.router.breaker.windowMs, 600_000);
  assert.equal(thresholds.claude.challengerShare.value, 0.1);
});

test("the Bible 12.2 take gate numbers are in thresholds.take, and no take limit is invented", () => {
  assert.equal(thresholds.take.durationTolerance.value, 0.1, "duration within +-10 per cent of the shot");
  assert.equal(thresholds.take.blackOrFrozenFramesMax.value, 2, "no black or frozen run over 2 frames");
  assert.equal(thresholds.take.flickerMax.value, 0.25, "flicker below 0.25");
  assert.equal(thresholds.take.motionMin.value, 0.05, "motion above 0.05 for motion shots");
  assert.equal(thresholds.take.generatedWordsMax, 0, "no generated text");
  assert.equal(thresholds.take.rubricFrames, 6, "the Haiku rubric sees 6 frames");
  assert.equal(thresholds.escalation.criticConfidence.value, 0.6, "escalate below 0.6 critic confidence");
});

test("the Claude token rates are in prices.tokenRates at the Bible 11.1 values, Haiku at Haiku 4.5's rate", () => {
  assert.deepEqual(prices.tokenRates["anthropic/claude-opus-5.5"], { inputUsdPerMillion: 4, outputUsdPerMillion: 20 });
  assert.deepEqual(prices.tokenRates["anthropic/claude-sonnet-5.5"], { inputUsdPerMillion: 2, outputUsdPerMillion: 10 });
  assert.deepEqual(prices.tokenRates["anthropic/claude-haiku-5.5"], { inputUsdPerMillion: 1, outputUsdPerMillion: 5 });
});

test("the token rate keys are exactly the Claude models the route table names, so no route is unpriced", () => {
  const claudeCapabilities: Capability[] = ["llm.direction", "llm.analysis", "llm.check"];
  const routed = new Set<string>();
  for (const capability of claudeCapabilities) {
    for (const target of routes.table[capability].targets) {
      assert.ok(target.model !== null, `${capability} has no model`);
      routed.add(target.model);
    }
  }
  assert.deepEqual([...routed].sort(), Object.keys(prices.tokenRates).sort());
});

test("the platform size limit is not in the Bible, so it stays null until the owner sets it", () => {
  assert.equal(thresholds.render.platformMaxBytes, null);
});

test("the Bible 14.2 fixed cost of a master is about $0.52", () => {
  const fixed = Object.values(budgets.fixedPerMasterUsd);
  assert.equal(sumUsd(fixed), 0.52);
  assert.equal(budgets.productionMode, "cap");
  assert.equal(budgets.redoAllowanceShare.value, 0.25);
});

test("the Bible 10.3 list prices are in the table with their units", () => {
  const expected: [PriceKey, number, string][] = [
    ["kling_v3_standard", 0.126, "per_second"],
    ["veo_3_1_fast", 0.1, "per_second"],
    ["seedance_2_5", 0.1028, "per_second"],
    ["seedance_2_0_mini", 0.0336, "per_second"],
    ["wan_3_0", 0.0425, "per_second"],
    ["veo_3_1_lite", 0.05, "per_second"],
    ["heygen_avatar_iv", 0.05, "per_second"],
    ["seedream_5_flash", 0.018, "per_image"],
    ["seedream_4_5", 0.04, "per_image"],
    ["eleven_v4", 40, "per_million_characters"],
    ["render_shotstack", 0.2, "per_minute"],
  ];
  for (const [key, usd, unit] of expected) {
    assert.equal(priceFor(key).usd, usd, `${key} price`);
    assert.equal(priceFor(key).unit, unit, `${key} unit`);
    assert.equal(priceFor(key).source, "list_oct_2026");
  }
});

test("prices the Bible does not state as a number are null, never a guess", () => {
  const unknown: PriceKey[] = [
    "i2v_pinned_model",
    "nano_banana_2",
    "gpt_image_2",
    "gemini_3_8_flash_tts",
    "stt_vendor",
    "lipsync_vendor",
    "background_removal_vendor",
    "upscaling_vendor",
    "render_hyperframes_cloud",
    "render_remotion_lambda",
  ];
  for (const key of unknown) {
    assert.equal(priceFor(key).usd, null, `${key} must stay unknown`);
  }
});

test("every model class has a default route, and every route names a priced entry", () => {
  for (const modelClass of MODEL_CLASSES) {
    const key = prices.routeFor[modelClass];
    assert.ok(key in prices.entries, `${modelClass} routes to an unknown key ${key}`);
  }
  for (const key of Object.values(prices.sourceRoutes)) {
    assert.ok(key in prices.entries, `source route ${key} is not in the table`);
  }
});

test("the default route for video.cinematic is Kling first, and for video.budget Seedance 2.0 Mini (10.3 order)", () => {
  assert.equal(prices.routeFor["video.cinematic"], "kling_v3_standard");
  assert.equal(prices.routeFor["video.budget"], "seedance_2_0_mini");
});
