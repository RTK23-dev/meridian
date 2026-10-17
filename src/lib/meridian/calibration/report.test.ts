import assert from "node:assert/strict";
import test from "node:test";
import { calibrationReport } from "./report.ts";

test("a row with no score is left out of the calibration report", () => {
  const report = calibrationReport([
    { probability: 0.8, outcome: true },
    { outcome: false },
  ]);
  assert.equal(report.sampleSize, 1);
  assert.equal(report.brierScore, 0.04);
  assert.match(report.note, /1 row/);
});
