// The checks against a cookbook's targets (K22): pass, near, miss and unknown; an unreadable measure is never a pass.

import assert from "node:assert/strict";
import { test } from "node:test";
import { checkOutputs, reportLines } from "./checks.ts";
import { measuresOf, numericMeasures } from "../../../engine/analyze/measures.ts";

const CHECKS = [
  { measure: "hardCuts" as const, target: 9, tolerance: 1 },
  { measure: "shotP50Ms" as const, target: 4000, tolerance: 500 },
  { measure: "integratedLufs" as const, target: -14, tolerance: 1 },
];

test("a value within the tolerance passes; within twice the tolerance it is near; further it misses", () => {
  const outcomes = checkOutputs(CHECKS, { hardCuts: 9, shotP50Ms: 4900, integratedLufs: -16.5 });
  assert.deepEqual(
    outcomes.map((outcome) => outcome.verdict),
    ["pass", "near", "miss"],
  );
});

test("a measure that was not read is unknown, and never a pass, even when the target is zero", () => {
  const outcomes = checkOutputs([{ measure: "hardCuts", target: 0, tolerance: 1 }], { hardCuts: null });
  assert.equal(outcomes[0]?.verdict, "unknown");
  assert.equal(checkOutputs(CHECKS, {}).every((outcome) => outcome.verdict === "unknown"), true);
  assert.equal(checkOutputs(CHECKS, { hardCuts: Number.NaN })[0]?.verdict, "unknown", "NaN is not a value");
});

test("the report has one plain line per check, with the value or that it was not measured", () => {
  const lines = reportLines(checkOutputs(CHECKS, { hardCuts: 8, shotP50Ms: null, integratedLufs: -14 }));
  assert.equal(lines[0], "hardCuts: 8 against 9 (+/- 1): pass");
  assert.equal(lines[1], "shotP50Ms: not measured against 4000 (+/- 500): unknown");
});

test("the measures of a recorded video feed the checks by name: the recorded cut count passes, and the loudness misses a tight tolerance (K22)", () => {
  const measures = numericMeasures(
    measuresOf({
      durationMs: 6000,
      cutsMs: [1000, 2500, 4000],
      pairs: [],
      loopDistance: 0.02,
      meanMotion: 0.25,
      flickerScore: 0.1,
      brightness: [0.2, 0.4],
      integratedLufs: -14.2,
      loudnessRangeLu: 6.5,
    }),
  );
  const outcomes = checkOutputs(
    [
      { measure: "hardCuts", target: 3, tolerance: 0 },
      { measure: "integratedLufs", target: -14, tolerance: 0.05 },
    ],
    measures,
  );
  assert.deepEqual(
    outcomes.map((outcome) => outcome.verdict),
    ["pass", "miss"],
  );
});
