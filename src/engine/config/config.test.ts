import assert from "node:assert/strict";
import test from "node:test";
import { EFFECT_KINDS, EngineError, MODEL_CLASSES, sumUsd, VISUAL_TYPES } from "../contracts/index.ts";
import { adapters } from "./adapters.ts";
import { budgets } from "./budgets.ts";
import { CONTRACTS_VERSION } from "../contracts/version.ts";
import { modelPreferences, PREFERENCE_MODEL_CLASSES } from "./model-preferences.ts";
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
  collectTunables(adapters, "adapters", found);
  assert.equal(found.length, 79, `expected 79 tunables (thresholds 46, weights 16, budgets 1, adapters 16), found ${found.length}`);
  for (const [path, value] of found) {
    assert.ok(value.floor <= value.value && value.value <= value.ceiling, `${path} is outside its bounds`);
    assert.ok(Number.isFinite(value.value), `${path} is not finite`);
  }
});

test("each config file carries its version string", () => {
  assert.equal(thresholds.version, "thresholds@3");
  assert.equal(weights.version, "weights@1");
  assert.equal(prices.version, "prices@2");
  assert.equal(budgets.version, "budgets@1");
  assert.equal(adapters.version, "adapters@1");
});

test("the contract set is at version 9 (the ledger's providerRef, Bible section 4 v9 note)", () => {
  assert.equal(CONTRACTS_VERSION, "engine-contracts@9");
});

test("the speech targets are the OpenRouter ids of the owner's decision (2026-10-17), unverified, and each has a price key", () => {
  const speech = routes.table.tts.targets;
  assert.deepEqual(
    speech.map((target) => [target.provider, target.model, target.priceKey, target.verified]),
    [
      ["openrouter", "elevenlabs/eleven-v4", "eleven_v4", false],
      ["openrouter", "google/gemini-3.8-flash-tts", "gemini_3_8_flash_tts", false],
    ],
  );
  assert.equal(priceFor("eleven_v4").usd, 40);
  assert.equal(priceFor("eleven_v4").unit, "per_million_characters");
  assert.equal(priceFor("gemini_3_8_flash_tts").usd, 9);
  assert.equal(priceFor("gemini_3_8_flash_tts").unit, "per_million_output_tokens");
  assert.equal(priceFor("gemini_3_8_flash_tts").source, "openrouter_listing");
});

test("the tiers the v8 roles run on are routed to priced Claude models: scriptwriter on llm.direction, model_chooser on llm.check", () => {
  // The roles keep no config of their own: each runs on a capability, and the route table and the token rates price it.
  const direction = routes.table["llm.direction"].targets[0];
  const check = routes.table["llm.check"].targets[0];
  assert.equal(direction.model, "anthropic/claude-opus-5.5", "scriptwriter runs on the Opus tier (Bible 11.1 direction)");
  assert.equal(check.model, "anthropic/claude-haiku-5.5", "model_chooser runs on the Haiku check tier (Bible 11.1 check)");
  assert.ok(direction.model !== null && direction.model in prices.tokenRates, "the direction tier has a token rate");
  assert.ok(check.model !== null && check.model in prices.tokenRates, "the check tier has a token rate");
});

test("the model preference table is versioned, covers the production classes and starts empty (Bible 10.5 step 4)", () => {
  assert.equal(modelPreferences.version, "model-preferences@1");
  assert.deepEqual([...PREFERENCE_MODEL_CLASSES], ["video.cinematic", "video.budget", "video.i2v_pinned", "avatar", "image.keyframe", "image.edit", "tts"]);
  assert.deepEqual(Object.keys(modelPreferences.ranked).sort(), [...PREFERENCE_MODEL_CLASSES].sort(), "one row per production class, and no other");
  for (const modelClass of PREFERENCE_MODEL_CLASSES) {
    assert.ok(MODEL_CLASSES.includes(modelClass), `${modelClass} is a model class of the contract`);
    assert.deepEqual(modelPreferences.ranked[modelClass], [], `${modelClass} starts with no preference (owner decision 2026-10-16)`);
  }
});

test("the lip-sync class has no preference row: it is not a production class until E2 (Bible 10.5)", () => {
  assert.equal((PREFERENCE_MODEL_CLASSES as readonly string[]).includes("lipsync"), false);
  assert.equal("lipsync" in modelPreferences.ranked, false);
});

test("the assets constants moved to config keep the values assets/STATUS.md recorded", () => {
  assert.equal(adapters.polling.intervalMs.value, 5_000);
  assert.equal(adapters.retry.backoffBaseMs.value, 1_000);
  assert.equal(adapters.retry.backoffCapMs.value, 30_000);
  assert.equal(adapters.reliabilityWindowMs, 7 * 24 * 60 * 60 * 1000);
  assert.equal(adapters.timeoutsMs.videoSubmit.value, 60_000);
  assert.equal(adapters.catalog.ttlMs.value, 10 * 60_000, "the catalog read is kept for 10 minutes (initial, Bible 10.5 step 1)");
  assert.equal(adapters.timeoutsMs.image.value, 120_000);
  assert.equal(adapters.timeoutsMs.speech.value, 120_000);
  assert.equal(adapters.timeoutsMs.pexels.value, 30_000);
  assert.equal(adapters.timeoutsMs.pixabay.value, 30_000);
  assert.equal(adapters.outputLimits.imageMinBytes.value, 1024);
  assert.equal(adapters.outputLimits.imageMaxBytes.value, 32 * 1024 * 1024);
  assert.equal(adapters.outputLimits.speechMinBytes.value, 1024);
  assert.equal(adapters.outputLimits.speechMaxBytes.value, 64 * 1024 * 1024);
  assert.equal(adapters.outputLimits.urlMaxLength.value, 2048);
  assert.equal(adapters.stock.pexels.perPage.value, 15);
  assert.equal(adapters.stock.pixabay.perPage.value, 20);
  assert.deepEqual(adapters.output, { width: 1080, height: 1920 });
});

test("the Bible gives 1080 x 1920 output, the 7-day reliability window and the lease times; the rest is Tunable", () => {
  assert.equal(adapters.output.width, 1080);
  assert.equal(adapters.output.height, 1920);
  assert.equal(thresholds.jobs.leaseMs.generation, 600_000);
  assert.equal(thresholds.jobs.leaseMs.claude, 120_000);
  assert.equal(thresholds.jobs.leaseMs.render, 300_000);
});

test("the plan lease is three Claude leases in sequence (6 minutes), so it moves with the Claude lease (thresholds@3)", () => {
  assert.equal(thresholds.jobs.leaseMs.plan, 3 * thresholds.jobs.leaseMs.claude);
  assert.equal(thresholds.jobs.leaseMs.plan, 360_000);
});

test("the editor's Bible 8.2 numbers are plain where the Bible gives them, with the values edit/tuning.ts held", () => {
  const editor = thresholds.editor;
  assert.deepEqual(editor.cutSnap, { gapMinMs: 80, windowMs: 250, beatWindowMs: 120 }, "8.2 step 3: 80 ms gap, 250 ms and 120 ms windows");
  assert.deepEqual(editor.fit, { shortShare: 0.5, longShare: 1.5 }, "8.2 step 4: 0.5x and 1.5x the target");
  assert.deepEqual(editor.hook, { captionByMs: 500, motionWithinMs: 300 }, "8.2 step 5: caption by 500 ms, motion within 300 ms");
  assert.equal(editor.loopMs, 500, "8.2 step 12: the last 500 ms");
  assert.equal(editor.punch.jitterShare, 0.1, "8.2 step 13: within +-10 per cent");
  assert.equal(editor.music.duckDb, -18, "8.2 step 11: ducked by 18 dB");
});

test("the editor's Tunables keep the values edit/tuning.ts held, inside their bounds", () => {
  const editor = thresholds.editor;
  assert.equal(editor.effectClashMs.value, 300);
  assert.equal(editor.punch.minScale.value, 1.02);
  assert.equal(editor.punch.floorScale.value, 1.01);
  assert.equal(editor.punch.maxScale.value, 1.5);
  assert.equal(editor.punch.intensityDivisor.value, 4);
  assert.equal(editor.music.baseGainDb.value, -12);
  assert.equal(editor.captions.maxPerClip.value, 60);
  assert.equal(editor.captions.maxWordsPerCaption.value, 8);
  assert.equal(editor.maxDrawableGainDb.value, 12);
  assert.equal(editor.loudnessRoundingLufs.value, 0.05);
  assert.equal(editor.geometry.captionLeftShare.value, 0.06);
  assert.equal(editor.geometry.captionWidthShare.value, 0.82);
  assert.equal(editor.geometry.captionHeightShare.value, 0.07);
  assert.deepEqual(
    { upper: editor.geometry.captionTopShare.upper.value, middle: editor.geometry.captionTopShare.middle.value, lower: editor.geometry.captionTopShare.lower.value },
    { upper: 0.16, middle: 0.47, lower: 0.6 },
  );
  assert.deepEqual(
    {
      x: editor.geometry.assumedFaceBox.x.value,
      y: editor.geometry.assumedFaceBox.y.value,
      w: editor.geometry.assumedFaceBox.w.value,
      h: editor.geometry.assumedFaceBox.h.value,
    },
    { x: 0.2, y: 0.1, w: 0.6, h: 0.4 },
  );
});

test("the break pattern is the regular expression edit/tuning.ts held, so caption breaks do not change", () => {
  assert.equal(new RegExp(thresholds.editor.captions.breakPattern).source, /[.!?;:,]$/.source);
  const breaks = new RegExp(thresholds.editor.captions.breakPattern);
  assert.equal(breaks.test("sky."), true);
  assert.equal(breaks.test("sky"), false);
});

test("the caption boxes at their initial values sit inside the Bible 8.3 safe zones (top 10, bottom 20, right 12 per cent)", () => {
  const geometry = thresholds.editor.geometry;
  const top = geometry.captionTopShare;
  assert.ok(top.upper.value >= 0.1, "the upper band starts at or below the top 10 per cent");
  assert.ok(top.lower.value + geometry.captionHeightShare.value <= 0.8, "the lower band ends at or above the bottom 20 per cent");
  assert.ok(geometry.captionLeftShare.value + geometry.captionWidthShare.value <= 0.88, "the caption ends inside the right 12 per cent");
  assert.ok(top.upper.floor >= 0.1, "no bound lets the upper band into the top 10 per cent");
  assert.ok(top.lower.ceiling + geometry.captionHeightShare.value <= 0.8 + 1e-9, "the lower band's ceiling keeps it above the bottom 20 per cent");
});

test("the slideshow risk numbers and lists moved from review/tuning.ts keep their values (12.3, thresholds@3)", () => {
  const slideshow = thresholds.slideshow;
  assert.equal(slideshow.codedRunMax, 4, "five coded shots in a row is blocked (Bible 19 E4), so four is the longest that passes");
  assert.deepEqual(Object.keys(slideshow.weights).sort(), [
    "decorative_visuals",
    "repetition",
    "shot_intent",
    "typography_over_reliance",
    "unsupported_cinematic_claims",
    "weak_motion",
  ]);
  for (const [dimension, weight] of Object.entries(slideshow.weights)) {
    assert.equal(weight.value, 1, `${dimension} starts equal`);
    assert.ok(weight.floor > 0, `${dimension} has a positive floor, so the weighted mean never divides by zero`);
  }
  assert.equal(slideshow.contentWordMinLength.value, 4);
  assert.ok(slideshow.stopWords.includes("about") && slideshow.stopWords.includes("yours"));
  assert.equal(slideshow.motionModelClassPrefix, "video.");
});

test("the slideshow lists name only members of the contract enums (no typo can silently change a check)", () => {
  const slideshow = thresholds.slideshow;
  for (const kind of slideshow.motionEffectKinds) {
    assert.ok((EFFECT_KINDS as readonly string[]).includes(kind), `${kind} is not an EDL effect kind`);
  }
  for (const modelClass of slideshow.stillModelClasses) {
    assert.ok((MODEL_CLASSES as readonly string[]).includes(modelClass), `${modelClass} is not a model class`);
  }
  for (const type of slideshow.cinematicClaimTypes) {
    assert.ok((VISUAL_TYPES as readonly string[]).includes(type), `${type} is not a visual type`);
  }
  assert.ok(
    MODEL_CLASSES.some((modelClass) => modelClass.startsWith(slideshow.motionModelClassPrefix)),
    "the motion prefix matches a model class",
  );
});

test("the audio gain cap is the compiler's 3.98 (+12 dB), so the ceiling of the drawable gain is that cap", () => {
  assert.equal(thresholds.editor.maxDrawableGainDb.ceiling, 12);
  assert.ok(Math.abs(10 ** (thresholds.editor.maxDrawableGainDb.value / 20) - 3.98) < 0.01, "+12 dB is about 3.98 times");
});

test("the breaker minimum sample and the scoring minimum are integers inside their bounds (E3 initial values)", () => {
  const minSample = thresholds.router.breaker.minSample;
  const minAttempts = thresholds.router.minAttempts;
  assert.equal(minSample.value, 5);
  assert.equal(minAttempts.value, 10);
  for (const tuned of [minSample, minAttempts, adapters.stock.pexels.perPage, adapters.stock.pixabay.perPage]) {
    assert.ok(Number.isInteger(tuned.value), `${tuned.value} must be an integer`);
  }
  for (const bytes of [
    adapters.outputLimits.imageMinBytes,
    adapters.outputLimits.imageMaxBytes,
    adapters.outputLimits.speechMinBytes,
    adapters.outputLimits.speechMaxBytes,
    adapters.outputLimits.urlMaxLength,
  ]) {
    assert.ok(Number.isInteger(bytes.value), `${bytes.value} must be an integer`);
  }
});

test("the Pixabay page size is inside its documented range (3 to 200, PROVIDER_APIS.md)", () => {
  assert.equal(adapters.stock.pixabay.perPage.floor, 3);
  assert.equal(adapters.stock.pixabay.perPage.ceiling, 200);
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
