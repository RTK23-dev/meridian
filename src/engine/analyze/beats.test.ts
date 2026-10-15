import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dbfs,
  estimateBpm,
  measureSound,
  musicShare,
  onsetStrength,
  percentile,
  silenceBeforeMs,
  soundHits,
  spokenWindows,
} from "./beats.ts";

const STEP = 10;

/** A click track: a burst of `burstSteps` steps of level `level` every `periodSteps` steps, for `count` clicks. */
function clickTrack(
  periodSteps: number,
  count: number,
  level = 0.35,
  burstSteps = 6,
  offsetSteps = 0,
): number[] {
  const total = offsetSteps + periodSteps * count + 1;
  const rms = new Array<number>(total).fill(0);
  for (let click = 0; click < count; click++) {
    const start = offsetSteps + click * periodSteps;
    for (let step = start; step < start + burstSteps && step < total; step++) rms[step] = level;
  }
  return rms;
}

describe("dbfs and percentiles", () => {
  it("reads silence as the floor and full scale as 0 dBFS", () => {
    assert.equal(dbfs(0), -100);
    assert.equal(dbfs(1), 0);
  });

  it("interpolates percentiles and rejects an empty list", () => {
    assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
    assert.equal(percentile([10], 90), 10);
    assert.throws(() => percentile([], 50));
  });
});

describe("the beat grid", () => {
  it("finds one sound hit per click of a click track, at the click times", () => {
    // A click every 500 ms (50 steps of 10 ms), the first at 100 ms. A click at 0 has no level before it to rise from. The onset
    // strength compares each window with the one 20 ms earlier, so its peak is the second step of the rise: 110 ms, not 100 ms.
    const rms = clickTrack(50, 8, 0.35, 6, 10);
    const hits = soundHits(onsetStrength(rms, STEP), STEP);
    assert.deepEqual(hits, [110, 610, 1110, 1610, 2110, 2610, 3110, 3610]);
  });

  it("reads 120 beats per minute from a 500 ms click track", () => {
    const rms = clickTrack(50, 30);
    assert.equal(estimateBpm(onsetStrength(rms, STEP), STEP), 120);
  });

  it("reports no tempo for silence, rather than a guess", () => {
    assert.equal(estimateBpm(onsetStrength(new Array<number>(4000).fill(0), STEP), STEP), null);
  });

  it("reports no tempo for a signal too short to show two beats of the slowest tempo", () => {
    assert.equal(estimateBpm(onsetStrength(clickTrack(50, 2), STEP), STEP), null);
  });
});

describe("speech, music and silence", () => {
  it("marks the windows that start inside a spoken word", () => {
    const mask = spokenWindows([{ startMs: 100, endMs: 250 }], STEP, 40);
    assert.equal(mask[9], false);
    assert.equal(mask[10], true);
    assert.equal(mask[24], true);
    assert.equal(mask[25], false);
  });

  it("counts music only outside speech, and over the whole duration", () => {
    const rms = new Array<number>(100).fill(0.3); // loud everywhere
    const speech = [{ startMs: 0, endMs: 400 }]; // the first 40 windows are speech
    assert.equal(musicShare(rms, STEP, speech, -40), 0.6);
  });

  it("finds a silence before the payoff only when it is longer than 300 ms", () => {
    const rms = [...new Array<number>(50).fill(0.3), ...new Array<number>(40).fill(0)];
    assert.equal(silenceBeforeMs(900, rms, STEP), 400);
    assert.equal(silenceBeforeMs(540, rms, STEP), null);
  });

  it("separates sound effects from speech in measureSound", () => {
    const rms = clickTrack(50, 8, 0.35, 6, 10);
    const sound = measureSound({
      rms,
      stepMs: STEP,
      durationMs: 4000,
      speech: [{ startMs: 0, endMs: 100 }],
      payoffMs: null,
    });
    assert.equal(sound.hitsMs.length, 8);
    assert.equal(
      sound.soundEffectHitsMs.length,
      7,
      "the hit at 100 ms is within the spoken word's padding, so it is speech-aligned",
    );
    assert.equal(sound.bpm, 120);
    assert.equal(sound.silenceBeforePayoffMs, null);
  });
});
