import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateDecayWeight,
  updateBetaWeighted,
  hierarchicalColdStartPrior,
  betaMean,
  betaInterval,
  updateBeta,
  jeffreysPrior,
} from "../stats/beta.ts";

test("Decay math: calculation yields 1.0 for immediate observations and 0.5 at half-life", () => {
  const now = 1_700_000_000_000;
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  // Immediate observation
  const immediateWeight = calculateDecayWeight(now, now, 30);
  assert.equal(immediateWeight, 1.0);

  // At exactly 30 days old with a 30-day half-life
  const halfLifeWeight = calculateDecayWeight(now - thirtyDaysMs, now, 30);
  assert.ok(Math.abs(halfLifeWeight - 0.5) < 1e-4, `Expected ~0.5, got ${halfLifeWeight}`);

  // At 60 days old (two half lives -> 0.25)
  const twoHalfLivesWeight = calculateDecayWeight(now - 2 * thirtyDaysMs, now, 30);
  assert.ok(Math.abs(twoHalfLivesWeight - 0.25) < 1e-4, `Expected ~0.25, got ${twoHalfLivesWeight}`);

  // Future timestamp (clamped to 0 age) yields 1.0
  const futureWeight = calculateDecayWeight(now + 10000, now, 30);
  assert.equal(futureWeight, 1.0);
});

test("Weighted Beta updating: stale observations contribute less than fresh ones", () => {
  const prior = jeffreysPrior(); // alpha: 0.5, beta: 0.5

  // Two observations: one fresh (weight 1.0, 100 successes / 1000 trials)
  // and one old (weight 0.2, 500 successes / 1000 trials)
  const observations = [
    { successes: 100, trials: 1000, weight: 1.0 },
    { successes: 500, trials: 1000, weight: 0.2 },
  ];

  const posterior = updateBetaWeighted(prior, observations);

  // Fresh contribution: 100 success, 900 failures
  // Old contribution: 500 * 0.2 = 100 success, (1000 - 500) * 0.2 = 100 failures
  // Total expected: alpha = 0.5 + 100 + 100 = 200.5
  // Total expected: beta = 0.5 + 900 + 100 = 1000.5
  assert.equal(posterior.alpha, 200.5);
  assert.equal(posterior.beta, 1000.5);

  const mean = betaMean(posterior);
  assert.ok(mean > 0.16 && mean < 0.17);

  // Unweighted version would give much higher success rate:
  const unweighted = updateBeta(updateBeta(prior, 100, 1000), 500, 1000);
  const unweightedMean = betaMean(unweighted);
  assert.ok(unweightedMean > 0.29); // Stale high CTR skewed the unweighted posterior
});

test("Hierarchical cold-start priors: smoothly regularize small-sample estimates", () => {
  // DTC vertical benchmark CTR is 2.5% (0.025)
  const prior = hierarchicalColdStartPrior(0.025, 40);
  assert.ok(prior.alpha > 0.5);
  assert.ok(prior.beta > 0.5);

  const meanPrior = betaMean(prior);
  assert.ok(Math.abs(meanPrior - 0.025) < 0.001);

  // With just 10 clicks out of 200 impressions (5% raw CTR)
  const updated = updateBeta(prior, 10, 200);
  const updatedMean = betaMean(updated);
  
  // Shrinks toward vertical prior (lower than 0.05, higher than 0.025)
  assert.ok(updatedMean > 0.025 && updatedMean < 0.05);

  const interval = betaInterval(updated, 0.95);
  assert.ok(interval.low < updatedMean && interval.high > updatedMean);
});
