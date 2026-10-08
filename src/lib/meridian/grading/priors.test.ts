import assert from "node:assert/strict";
import test from "node:test";
import { SEED_PRIORS, seedPrior, fittedWeight } from "./priors.ts";

test("CalibratedParameter separates seed_prior from fitted_weight", () => {
  const heuristic = seedPrior(0.35, "Initial heuristic baseline");
  assert.equal(heuristic.origin, "seed_prior");
  assert.equal(heuristic.sampleCount, 0);

  const calibrated = fittedWeight(0.42, 1200, "Calibrated on 1,200 brand video outcomes");
  assert.equal(calibrated.origin, "fitted_weight");
  assert.equal(calibrated.sampleCount, 1200);
  assert.equal(calibrated.value, 0.42);
});

test("SEED_PRIORS contains explicitly labeled priors for hook retention and speech pace", () => {
  assert.equal(SEED_PRIORS.hookRetentionBetas.motion.origin, "seed_prior");
  assert.equal(SEED_PRIORS.hookRetentionBetas.facePresence.origin, "seed_prior");
  assert.equal(SEED_PRIORS.speechProsodyWpm.sweetSpotMin.origin, "seed_prior");
  assert.equal(SEED_PRIORS.speechProsodyWpm.sweetSpotMax.origin, "seed_prior");
});
