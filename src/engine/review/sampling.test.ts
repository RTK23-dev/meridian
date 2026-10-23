import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  afterSampleDecision,
  EMPTY_SAMPLING_STATE,
  isSampled,
  samplingRateOf,
  SAMPLING,
  withThresholdVersion,
  type SamplingState,
} from "./sampling.ts";

const NOW = "2026-10-20T10:00:00.000Z";
const LATER = "2026-10-27T10:00:01.000Z";

describe("sampling rates (Bible 6.14, 12.5)", () => {
  it("samples every video of a new format until 50 pass in a row, then 5%", () => {
    assert.equal(samplingRateOf(EMPTY_SAMPLING_STATE, NOW), 1, "a new format is sampled at 100%");
    const almost: SamplingState = { ...EMPTY_SAMPLING_STATE, consecutivePasses: SAMPLING.passesToLeaveNewFormat - 1 };
    assert.equal(samplingRateOf(almost, NOW), 1, "49 passes is still a new format");
    const passed: SamplingState = { ...EMPTY_SAMPLING_STATE, consecutivePasses: SAMPLING.passesToLeaveNewFormat };
    assert.equal(samplingRateOf(passed, NOW), 0.05, "50 passes in a row leaves it at 5%");
  });

  it("drops to 20% for a week after a gate threshold change, and counts passes again from zero", () => {
    const passed: SamplingState = { ...EMPTY_SAMPLING_STATE, consecutivePasses: 60, thresholdVersion: "v1" };
    const changed = withThresholdVersion(passed, "v2", NOW);
    assert.equal(changed.consecutivePasses, 0, "a threshold change starts the pass count again");
    assert.equal(samplingRateOf(changed, NOW), 0.2, "during the reset week the rate is 20%");
    assert.equal(samplingRateOf(changed, LATER), 1, "after the week, a format with few passes is a new format again");
  });

  it("records the first threshold version without a reset, and leaves an unchanged version alone", () => {
    const first = withThresholdVersion(EMPTY_SAMPLING_STATE, "v1", NOW);
    assert.equal(first.thresholdVersion, "v1");
    assert.equal(first.resetUntil, null, "nothing was sampled under another version, so no reset");
    assert.equal(withThresholdVersion(first, "v1", NOW), first, "the same version changes nothing");
  });
});

describe("the draw", () => {
  it("is fixed per request and video, so a retry samples the same videos", () => {
    const draw = { requestId: "req_a", videoId: "vid_a" };
    assert.equal(isSampled(draw, 0.5), isSampled(draw, 0.5));
    assert.equal(isSampled(draw, 1), true, "a rate of 1 samples every video");
    assert.equal(isSampled(draw, 0), false, "a rate of 0 samples none");
  });

  it("samples about the rate's share of many videos, with a rate of 5% and a fixed hash", () => {
    let sampled = 0;
    for (let index = 0; index < 2000; index += 1) {
      if (isSampled({ requestId: "req_b", videoId: `vid_${index}` }, 0.05)) sampled += 1;
    }
    assert.ok(sampled > 60 && sampled < 140, `about 5% of 2000 are sampled, got ${sampled}`);
  });
});

describe("a human decision on a sampled video", () => {
  it("counts an accept as a pass in a row, and a reject starts the count again", () => {
    const after1 = afterSampleDecision(EMPTY_SAMPLING_STATE, "accept");
    assert.equal(after1.consecutivePasses, 1);
    const after2 = afterSampleDecision(after1, "accept");
    assert.equal(after2.consecutivePasses, 2);
    assert.equal(afterSampleDecision(after2, "reject").consecutivePasses, 0);
  });

  it("leaves the count alone for an action that does not decide the video's acceptance", () => {
    const state: SamplingState = { ...EMPTY_SAMPLING_STATE, consecutivePasses: 3 };
    assert.equal(afterSampleDecision(state, "edit_prompt"), state);
    assert.equal(afterSampleDecision(state, "change_visual_type"), state);
  });
});
