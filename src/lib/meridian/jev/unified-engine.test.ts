import assert from "node:assert/strict";
import test from "node:test";
import { computeBrierScore, computeLogLoss, assessReliability } from "./calibration.ts";

test("calibration metrics compute correct Brier score and log loss", () => {
  const samples = [
    { probability: 0.9, outcome: 1 },
    { probability: 0.8, outcome: 1 },
    { probability: 0.1, outcome: 0 },
    { probability: 0.2, outcome: 0 },
  ];

  const brier = computeBrierScore(samples);
  assert.ok(brier < 0.05);

  const logLoss = computeLogLoss(samples);
  assert.ok(logLoss < 0.3);

  const reliability = assessReliability(samples);
  assert.ok(reliability.calibrationGrade === "well_calibrated" || reliability.calibrationGrade === "moderate");
});
