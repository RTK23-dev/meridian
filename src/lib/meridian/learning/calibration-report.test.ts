import assert from "node:assert/strict";
import test from "node:test";
import { CALIBRATION_MINIMUM_SAMPLE, buildCalibrationReport, calibrationStateText, type CalibrationOutcome } from "./calibration-report.ts";
import { HELD_OUT_MINIMUM } from "./calibration-gate.ts";

const row = (predicted: number, observed: boolean): CalibrationOutcome => ({ predicted, observed });

function rows(count: number, predicted: number, observed: (index: number) => boolean): CalibrationOutcome[] {
  return Array.from({ length: count }, (_, index) => row(predicted, observed(index)));
}

test("the minimum sample is the held-out minimum the calibration gate already uses", () => {
  assert.equal(CALIBRATION_MINIMUM_SAMPLE, HELD_OUT_MINIMUM);
  assert.equal(CALIBRATION_MINIMUM_SAMPLE, 200);
});

test("below the threshold the report says not calibrated, with the count, and no calibration number", () => {
  const report = buildCalibrationReport(rows(HELD_OUT_MINIMUM - 1, 1, () => true));
  assert.equal(report.state, "not_calibrated");
  assert.equal(report.label, "Not calibrated");
  assert.equal(report.sampleSize, HELD_OUT_MINIMUM - 1);
  assert.equal(report.minimumSample, HELD_OUT_MINIMUM);
  assert.match(report.reason, /199 usable outcomes; 200 are required/);
  // A perfect-looking set of 199 outcomes must not produce a Brier score a reader could mistake for a measurement.
  assert.equal("brierScore" in report, false);
  assert.equal("calibrationError" in report, false);
  assert.equal("bins" in report, false);
  assert.equal(report.appliedToDecisions, false);
});

test("below the threshold with no outcomes at all, the count is zero and the state is still not calibrated", () => {
  const report = buildCalibrationReport([]);
  assert.equal(report.state, "not_calibrated");
  assert.equal(report.sampleSize, 0);
  assert.equal(report.excluded, 0);
});

test("at the threshold the report measures: a perfectly calibrated set has a Brier score and error of zero", () => {
  const report = buildCalibrationReport(rows(HELD_OUT_MINIMUM, 1, () => true));
  assert.equal(report.state, "measured");
  assert.equal(report.label, "Measured, not applied");
  assert.equal(report.sampleSize, HELD_OUT_MINIMUM);
  assert.equal(report.brierScore, 0);
  assert.equal(report.calibrationError, 0);
  assert.equal(report.appliedToDecisions, false);
  assert.match(report.note, /not applied to any threshold or decision/);
});

test("at the threshold a miscalibrated set reports the error the data shows, not a calibrated value", () => {
  // Stated 0.9, observed in half the cases: Brier = 0.5 * 0.1^2 + 0.5 * 0.9^2 = 0.41, and the bin error is |0.9 - 0.5| = 0.4.
  const report = buildCalibrationReport(rows(HELD_OUT_MINIMUM, 0.9, (index) => index % 2 === 0));
  assert.equal(report.state, "measured");
  assert.equal(report.brierScore, 0.41);
  assert.equal(report.calibrationError, 0.4);
  const bin = report.bins.find((entry) => entry.count > 0);
  assert.equal(bin?.from, 0.8);
  assert.equal(bin?.observedRate, 0.5);
});

test("mixed outcomes across bins: bin counts add up to the sample and each bin shows its own observed rate", () => {
  const low = rows(100, 0.1, (index) => index < 10);
  const high = rows(100, 0.9, (index) => index < 90);
  const report = buildCalibrationReport([...low, ...high]);
  assert.equal(report.state, "measured");
  assert.equal(report.sampleSize, 200);
  const counts = report.bins.reduce((sum, bin) => sum + bin.count, 0);
  assert.equal(counts, 200);
  assert.equal(report.bins[0]?.count, 100);
  assert.equal(report.bins[0]?.observedRate, 0.1);
  assert.equal(report.bins[4]?.count, 100);
  assert.equal(report.bins[4]?.observedRate, 0.9);
  assert.equal(report.calibrationError, 0);
  assert.equal(report.brierScore, 0.09);
});

test("mixed rows: rows without a usable probability or outcome are excluded and counted, never read as zero", () => {
  const usable = rows(HELD_OUT_MINIMUM - 1, 1, () => true);
  const unusable: CalibrationOutcome[] = [
    { predicted: null, observed: true },
    { predicted: undefined, observed: false },
    { predicted: Number.NaN, observed: true },
    { predicted: 1.5, observed: true },
    { predicted: -0.1, observed: false },
    { predicted: 0.7, observed: null },
    { predicted: 0.7, observed: undefined },
  ];
  // With the unusable rows counted as zero, the sample would reach 200 and produce a measurement. It must not.
  const report = buildCalibrationReport([...usable, ...unusable]);
  assert.equal(report.state, "not_calibrated");
  assert.equal(report.sampleSize, HELD_OUT_MINIMUM - 1);
  assert.equal(report.excluded, unusable.length);
});

test("mixed rows at the threshold: exclusions do not change the measured values", () => {
  const clean = rows(HELD_OUT_MINIMUM, 0.9, (index) => index % 2 === 0);
  const withNoise: CalibrationOutcome[] = [...clean, { predicted: Number.NaN, observed: true }, { predicted: 0.9, observed: null }];
  const plain = buildCalibrationReport(clean);
  const noisy = buildCalibrationReport(withNoise);
  assert.equal(noisy.state, "measured");
  assert.equal(noisy.excluded, 2);
  assert.equal(noisy.sampleSize, HELD_OUT_MINIMUM);
  assert.equal(noisy.state, "measured");
  assert.equal(plain.state, "measured");
  if (noisy.state === "measured" && plain.state === "measured") {
    assert.equal(noisy.brierScore, plain.brierScore);
    assert.equal(noisy.calibrationError, plain.calibrationError);
  }
});

test("a caller can set a smaller minimum, and the state follows it at exactly that count", () => {
  const below = buildCalibrationReport(rows(2, 0.5, () => true), { minimumSample: 3 });
  assert.equal(below.state, "not_calibrated");
  assert.equal(below.minimumSample, 3);
  const at = buildCalibrationReport(rows(3, 0.5, () => true), { minimumSample: 3 });
  assert.equal(at.state, "measured");
});

test("an invalid minimum falls back to the held-out minimum rather than measuring on a bad threshold", () => {
  const report = buildCalibrationReport(rows(10, 0.5, () => true), { minimumSample: 0 });
  assert.equal(report.minimumSample, HELD_OUT_MINIMUM);
  assert.equal(report.state, "not_calibrated");
});

test("the screen text names the state: not calibrated with the count below the threshold, and measured-not-applied above it", () => {
  const below = calibrationStateText(buildCalibrationReport(rows(12, 0.5, () => true)));
  assert.equal(below, "Not calibrated. 12 usable outcomes; 200 are required before any calibration is measured.");
  const at = calibrationStateText(buildCalibrationReport(rows(HELD_OUT_MINIMUM, 1, () => true)));
  assert.match(at, /^Measured on 200 recorded outcomes, not applied to any decision\./);
  assert.doesNotMatch(below, /Brier/);
});
