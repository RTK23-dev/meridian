import assert from "node:assert/strict";
import test from "node:test";
import {
  OrganicLearningFlywheel,
  type FormulaPosteriorState,
  type OrganicPostPerformance,
} from "./organic-telemetry.ts";

test("OrganicLearningFlywheel updates Beta posteriors with organic wins", () => {
  const prior: FormulaPosteriorState = {
    formulaCardId: "formula-1",
    niche: "Fitness",
    alpha: 5,
    beta: 5,
    expectedWinProbability: 0.5,
    sampleCount: 10,
    consecutiveDecliningWindows: 0,
    status: "active",
  };

  const perfWin: OrganicPostPerformance = {
    postId: "post-101",
    formulaCardId: "formula-1",
    niche: "Fitness",
    publishedAt: "2026-10-07T00:00:00Z",
    views: 85000,
    threeSecondHoldRate: 0.68,
    completionRate: 0.32,
    sharesPerK: 24,
    savesPerK: 38,
    followersGained: 140,
    beatsAccountMedian: true,
  };

  const updated = OrganicLearningFlywheel.updatePosterior(prior, perfWin);
  assert.equal(updated.alpha, 6);
  assert.equal(updated.beta, 5);
  assert.ok(updated.expectedWinProbability > 0.5);
  assert.equal(updated.status, "active");
});

test("OrganicLearningFlywheel detects formula fatigue and retires degrading formulas", () => {
  let state: FormulaPosteriorState = {
    formulaCardId: "formula-stale",
    niche: "Beauty",
    alpha: 8,
    beta: 2,
    expectedWinProbability: 0.8,
    sampleCount: 10,
    consecutiveDecliningWindows: 0,
    status: "active",
  };

  const lossPerf: OrganicPostPerformance = {
    postId: "loss",
    formulaCardId: "formula-stale",
    niche: "Beauty",
    publishedAt: "2026-10-07T00:00:00Z",
    views: 1200,
    threeSecondHoldRate: 0.25,
    completionRate: 0.08,
    sharesPerK: 2,
    savesPerK: 1,
    followersGained: 2,
    beatsAccountMedian: false,
  };

  // 1st declining window
  state = OrganicLearningFlywheel.updatePosterior(state, lossPerf);
  assert.equal(state.consecutiveDecliningWindows, 1);
  assert.equal(state.status, "active");

  // 2nd declining window -> triggers fatigue retirement
  state = OrganicLearningFlywheel.updatePosterior(state, lossPerf);
  assert.equal(state.consecutiveDecliningWindows, 2);
  assert.equal(state.status, "fatigued_retired");
});

test("selectFormulasForProduction reserves exploration slots for untested formulas", () => {
  const candidates: FormulaPosteriorState[] = [
    { formulaCardId: "f-proven-1", niche: "Tech", alpha: 20, beta: 5, expectedWinProbability: 0.8, sampleCount: 25, consecutiveDecliningWindows: 0, status: "active" },
    { formulaCardId: "f-proven-2", niche: "Tech", alpha: 18, beta: 6, expectedWinProbability: 0.75, sampleCount: 24, consecutiveDecliningWindows: 0, status: "active" },
    { formulaCardId: "f-new-explore", niche: "Tech", alpha: 1, beta: 1, expectedWinProbability: 0.5, sampleCount: 2, consecutiveDecliningWindows: 0, status: "exploring" },
    { formulaCardId: "f-dead", niche: "Tech", alpha: 2, beta: 10, expectedWinProbability: 0.16, sampleCount: 12, consecutiveDecliningWindows: 2, status: "fatigued_retired" },
  ];

  const selected = OrganicLearningFlywheel.selectFormulasForProduction(candidates, { batchSize: 3, explorationShare: 0.33 });
  assert.equal(selected.length, 3);
  // Never selects retired formulas
  assert.ok(!selected.some((s) => s.formulaCardId === "f-dead"));
  // Includes exploration candidate
  assert.ok(selected.some((s) => s.formulaCardId === "f-new-explore"));
});
