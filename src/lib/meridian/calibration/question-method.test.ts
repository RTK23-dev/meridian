import assert from "node:assert/strict";
import test from "node:test";
import {
  CALIBRATION_BIN_COUNT,
  CALIBRATION_MINIMUM_BIN_COUNT,
  CALIBRATION_MINIMUM_OBSERVATIONS,
  CALIBRATION_TARGET_SUCCESS_RATE,
  QUESTION_CALIBRATION_METHOD,
  calibrateQuestion,
  type CalibrationObservation,
} from "./question-method.ts";

/** `count` observations at one stated probability, of which the first `successes` succeed. */
function batch(predicted: number, count: number, successes: number): CalibrationObservation[] {
  return Array.from({ length: count }, (_, index) => ({ predicted, success: index < successes }));
}

test("the method has a version, and its constants are the values the owner reviews", () => {
  assert.equal(QUESTION_CALIBRATION_METHOD, "question-calibration.v1");
  assert.equal(CALIBRATION_MINIMUM_OBSERVATIONS, 100);
  assert.equal(CALIBRATION_BIN_COUNT, 5);
  assert.equal(CALIBRATION_MINIMUM_BIN_COUNT, 10);
  assert.equal(CALIBRATION_TARGET_SUCCESS_RATE, 0.7);
});

test("below the minimum sample the report is uncalibrated, gives no threshold, and says how many of how many were measured", () => {
  const result = calibrateQuestion([...batch(0.95, 10, 10), ...batch(0.9, 80, 80)]);
  assert.equal(result.status, "uncalibrated");
  assert.equal(result.threshold, null);
  assert.equal(result.sampleSize, 90);
  assert.equal(result.minimumSample, 100);
  assert.match(result.reason, /^90 of 100 observations measured\./);
});

test("at the minimum sample, a range that meets the target gives a calibrated threshold at its lower edge", () => {
  // 20 observations in the 0.6 to 0.8 bin (14 succeed, 70%), 80 in the top bin (60 succeed, 75%). The 0.4 to 0.6 bin is empty.
  const result = calibrateQuestion([...batch(0.7, 20, 14), ...batch(0.9, 80, 60)]);
  assert.equal(result.status, "calibrated");
  assert.equal(result.sampleSize, 100);
  assert.equal(result.threshold, 0.6);
  assert.equal(result.reliability[2]!.meetsTarget, false, "an empty bin below the threshold does not block it");
  assert.equal(result.reliability[3]!.meetsTarget, true);
  assert.equal(result.reliability[4]!.successRate, 0.75);
  assert.match(result.reason, /^100 observations measured\./);
});

test("the threshold is the lowest bin from which every bin up to the top one meets the target", () => {
  // The top bin meets the target, the 0.6 to 0.8 bin does not (4 of 20 succeed), the 0.4 to 0.6 bin does (16 of 20).
  const result = calibrateQuestion([...batch(0.9, 60, 50), ...batch(0.7, 20, 4), ...batch(0.5, 20, 16)]);
  assert.equal(result.status, "calibrated");
  assert.equal(result.threshold, 0.8, "a failing bin between two passing bins cuts the range above it");
});

test("a top bin below the target gives no threshold, and the reason gives its success rate", () => {
  const result = calibrateQuestion([...batch(0.5, 40, 36), ...batch(0.9, 60, 36)]);
  assert.equal(result.status, "uncalibrated");
  assert.equal(result.threshold, null);
  assert.equal(result.sampleSize, 100);
  assert.match(result.reason, /no threshold meets the rule\. The top bin has a success rate of 0\.6 at or above 0\.8; 0\.7 is required\./);
});

test("a top bin with fewer than the minimum bin count gives no threshold, and the reason gives its count", () => {
  const result = calibrateQuestion([...batch(0.5, 95, 90), ...batch(0.9, 5, 5)]);
  assert.equal(result.status, "uncalibrated");
  assert.equal(result.threshold, null);
  assert.match(result.reason, /The top bin has 5 observations at or above 0\.8; 10 are required\./);
});

test("the reliability table counts every observation once, in its bin, and a probability of 1 is in the top bin", () => {
  const result = calibrateQuestion([...batch(0.7, 20, 14), ...batch(1, 80, 60)]);
  assert.equal(result.reliability.length, 5);
  assert.equal(result.reliability.reduce((sum, bin) => sum + bin.count, 0), 100);
  assert.equal(result.reliability[4]!.count, 80);
  assert.equal(result.reliability[4]!.to, 1);
  assert.equal(result.reliability[2]!.count, 0);
  assert.equal(result.reliability[2]!.successRate, null);
  assert.equal(result.reliability[2]!.meanPredicted, null);
});

test("observations that are not probabilities, or not outcomes, are not counted", () => {
  const valid = [...batch(0.7, 20, 14), ...batch(0.9, 80, 60)];
  const unusable = [
    { predicted: Number.NaN, success: true },
    { predicted: 1.2, success: true },
    { predicted: -0.1, success: false },
    { predicted: 0.5, success: "yes" as unknown as boolean },
  ];
  const clean = calibrateQuestion(valid);
  const withUnusable = calibrateQuestion([...valid, ...unusable]);
  assert.equal(withUnusable.sampleSize, 100);
  assert.deepEqual(withUnusable, clean);
});

test("the same observations give the same report, in any order", () => {
  const observations = [...batch(0.7, 20, 14), ...batch(0.9, 80, 60), ...batch(0.5, 20, 12)];
  const forward = calibrateQuestion(observations);
  const reversed = calibrateQuestion([...observations].reverse());
  assert.deepEqual(reversed, forward);
  assert.deepEqual(calibrateQuestion(observations), forward);
});
