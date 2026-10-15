// The values the take and post-render checks read from the detectors (measures.ts). Pure: the results are written by hand to the
// schemas, and each null case is tested, since a null is what fails a gate closed.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  blackFramesResultSchema,
  flickerResultSchema,
  motionResultSchema,
  type BlackFramesResult,
} from "../../../functions/ffmpeg/types.ts";
import { blackAt, blackFrameMeasures, longestRunFrames, takeCodeMeasures } from "./measures.ts";

const run = (startMs: number, endMs: number) => ({ startMs, endMs, durationMs: endMs - startMs });

function video(overrides: Partial<BlackFramesResult> = {}): BlackFramesResult {
  return blackFramesResultSchema.parse({
    videoPresent: true,
    durationMs: 3000,
    fps: 30,
    blackRuns: [],
    frozenRuns: [],
    ...overrides,
  });
}

describe("longestRunFrames: the longest black or frozen run, in frames (Bible 12.2)", () => {
  it("counts a 500 ms black run as 15 frames at 30 fps", () => {
    assert.equal(longestRunFrames(video({ blackRuns: [run(1000, 1500)] })), 15);
  });

  it("takes the longest of the black and the frozen runs", () => {
    const result = video({ blackRuns: [run(1000, 1066)], frozenRuns: [run(0, 1500)] });
    assert.equal(longestRunFrames(result), 45);
  });

  it("counts two frames as two, and a run of nothing as zero", () => {
    assert.equal(longestRunFrames(video({ blackRuns: [run(1000, 1067)] })), 2);
    assert.equal(longestRunFrames(video()), 0);
  });

  it("is null with no video, or with an unknown frame rate: a frame count cannot be made without one", () => {
    assert.equal(
      longestRunFrames(
        blackFramesResultSchema.parse({
          videoPresent: false,
          durationMs: 3000,
          fps: null,
          blackRuns: [],
          frozenRuns: [],
        }),
      ),
      null,
    );
    assert.equal(longestRunFrames(video({ fps: null })), null);
  });

  it("counts a black run that reaches the end of the media to its last frame", () => {
    // blackdetect reports the last black frame's time (1966.67 ms) for a run that reaches the end of a 2000 ms clip at 30 fps.
    const result = video({ durationMs: 2000, blackRuns: [run(1000, 1967)] });
    assert.equal(
      longestRunFrames(result),
      30,
      "1000 ms to the end is 30 frames at 30 fps, the last included",
    );
  });
});

describe("blackAt and blackFrameMeasures: whether a frame is black (Bible 12.3)", () => {
  it("a time inside a mid-clip black run is black; the first non-black frame time is not", () => {
    const result = video({ blackRuns: [run(1000, 1500)] });
    assert.equal(blackAt(result, 1000), true);
    assert.equal(blackAt(result, 1499), true);
    assert.equal(blackAt(result, 1500), false);
    assert.equal(blackAt(result, 999), false);
  });

  it("a time in a black run that reaches the end is black, including the last frame", () => {
    const result = video({ durationMs: 2000, blackRuns: [run(1000, 1967)] });
    assert.equal(blackAt(result, 1967), true);
    assert.equal(blackAt(result, 1999), true);
  });

  it("a time past the end is not measured (null), and so is every time with no video", () => {
    assert.equal(blackAt(video({ blackRuns: [run(1000, 1500)] }), 3000), null);
    const none = blackFramesResultSchema.parse({
      videoPresent: false,
      durationMs: 3000,
      fps: null,
      blackRuns: [],
      frozenRuns: [],
    });
    assert.deepEqual(blackFrameMeasures(none, [500, 1200]), [
      { atMs: 500, black: null },
      { atMs: 1200, black: null },
    ]);
  });

  it("the post-render measurement of each required time is black or not, in the order asked", () => {
    const result = video({ blackRuns: [run(1000, 1500)] });
    assert.deepEqual(blackFrameMeasures(result, [500, 1200, 2000]), [
      { atMs: 500, black: false },
      { atMs: 1200, black: true },
      { atMs: 2000, black: false },
    ]);
  });
});

describe("takeCodeMeasures: the take's code checks from the detectors", () => {
  it("passes the flicker and motion values through, and the frame count of the black and frozen runs", () => {
    const measures = takeCodeMeasures({
      black: video({ blackRuns: [run(1000, 1500)] }),
      flicker: flickerResultSchema.parse({ videoPresent: true, frames: 90, flickerScore: 0.12 }),
      motion: motionResultSchema.parse({ videoPresent: true, frames: 89, meanMotion: 0.09 }),
    });
    assert.deepEqual(measures, {
      blackOrFrozenRunFrames: 15,
      flickerScore: 0.12,
      meanMotion: 0.09,
    });
  });

  it("leaves a value null when its detector saw no video, so the take's check is missing evidence", () => {
    const measures = takeCodeMeasures({
      black: blackFramesResultSchema.parse({
        videoPresent: false,
        durationMs: null,
        fps: null,
        blackRuns: [],
        frozenRuns: [],
      }),
      flicker: flickerResultSchema.parse({ videoPresent: false, frames: 0, flickerScore: null }),
      motion: motionResultSchema.parse({ videoPresent: false, frames: 0, meanMotion: null }),
    });
    assert.deepEqual(measures, {
      blackOrFrozenRunFrames: null,
      flickerScore: null,
      meanMotion: null,
    });
  });
});
