// The measures of one video from recorded media readings (K22): the same numbers the preset compare script prints, and a text measure is not
// a number. The readings are recorded values, so no media function runs here.

import assert from "node:assert/strict";
import { test } from "node:test";
import { loopOf } from "./zoom.ts";
import { measuresOf, numericMeasures, type MediaReadings } from "./measures.ts";

const RECORDED: MediaReadings = {
  durationMs: 6000,
  cutsMs: [1000, 2500, 4000],
  pairs: [],
  loopDistance: 0.02,
  meanMotion: 0.25,
  flickerScore: 0.1,
  brightness: [0.2, 0.4],
  integratedLufs: -14.2,
  loudnessRangeLu: 6.5,
};

test("the measures of a recorded video are the compare report's numbers, rounded as the report rounds them", () => {
  const m = measuresOf(RECORDED);
  assert.equal(m.durationMs, 6000);
  assert.equal(m.hardCuts, 3);
  assert.equal(m.firstCutMs, 1000);
  assert.equal(m.shotP50Ms, 1500, "the four shots are 1000, 1500, 1500 and 2000 ms, so the median is 1500");
  assert.equal(m.zoomJumps, 0, "no picture pairs, so no zoom jumps");
  assert.equal(m.punchInScale, null, "no punch-ins, so no scale");
  assert.equal(m.interruptMedianMs, 1500, "the gaps between the cuts have the same median");
  assert.equal(m.meanMotion, 0.25);
  assert.equal(m.flickerScore, 0.1);
  assert.equal(m.meanBrightness, 0.3);
  assert.equal(m.integratedLufs, -14.2);
  assert.equal(m.loudnessRangeLu, 6.5);
  assert.equal(m.loopDistance, 0.02);
  assert.equal(m.endsOnLoop, String(loopOf(0.02)), "the loop verdict is the analysis's own");
  assert.equal(m.cutsMs, "1000 2500 4000");
});

test("a reading that could not be made stays null, and a video with none of them still gives a set of measures (fail closed)", () => {
  const m = measuresOf({
    durationMs: null,
    cutsMs: [],
    pairs: [],
    loopDistance: null,
    meanMotion: null,
    flickerScore: null,
    brightness: [],
    integratedLufs: null,
    loudnessRangeLu: null,
  });
  assert.equal(m.durationMs, null, "no duration is unknown, not zero");
  assert.equal(m.hardCuts, 0);
  assert.equal(m.firstCutMs, null);
  assert.equal(m.shotP50Ms, null, "a timing measure needs a duration");
  assert.equal(m.interruptMedianMs, null);
  assert.equal(m.loopDistance, null, "a missing loop distance is null, not NaN");
  assert.equal(m.meanMotion, null);
  assert.equal(m.flickerScore, null);
  assert.equal(m.meanBrightness, null, "no brightness samples is not a brightness of zero");
  assert.equal(m.integratedLufs, null);
  assert.equal(m.endsOnLoop, "null", "no loop reading is not a loop");
});

test("the numeric measures keep the numbers and the nulls, and drop the text measures, so a check on a text measure is unknown (K22)", () => {
  const numeric = numericMeasures(measuresOf(RECORDED));
  assert.equal(numeric.hardCuts, 3);
  assert.equal(numeric.integratedLufs, -14.2);
  assert.equal(numeric.punchInScale, null);
  assert.equal("endsOnLoop" in numeric, false, "a text measure is not a number");
  assert.equal("cutsMs" in numeric, false);
});
