import assert from "node:assert/strict";
import { test } from "node:test";
import { EngineError, type EditDecisionList, type Take } from "../contracts/index.ts";
import type { BlackFramesResult, FlickerResult, MotionResult, SilenceResult } from "../media/interface.ts";
import { takeCodeMeasures } from "../media/measures.ts";
import { codeMeasuresOf, measuredOrNull, renderMeasuresFromDetectors, takeMeasurementsFromDetectors } from "./gate-measures.ts";
import { graphicsClipsOf } from "./handlers/post-render-review.ts";

const BYTES = new Uint8Array(8) as Uint8Array<ArrayBuffer>;
const TAKE: Pick<Take, "durationMs"> = { durationMs: 2990 };

const cleanBlack: BlackFramesResult = { videoPresent: true, durationMs: 3000, fps: 30, blackRuns: [], frozenRuns: [] };
const frozenBlack: BlackFramesResult = {
  videoPresent: true,
  durationMs: 3000,
  fps: 30,
  blackRuns: [],
  frozenRuns: [{ startMs: 1000, endMs: 1300, durationMs: 300 }],
};
const blackAtStart: BlackFramesResult = {
  videoPresent: true,
  durationMs: 3000,
  fps: 30,
  blackRuns: [{ startMs: 0, endMs: 500, durationMs: 500 }],
  frozenRuns: [],
};
const flicker: FlickerResult = { videoPresent: true, frames: 90, flickerScore: 0.2 };
const motion: MotionResult = { videoPresent: true, frames: 90, meanMotion: 0.1 };
const silence: SilenceResult = {
  audioPresent: true,
  durationMs: 3000,
  minSilenceMs: 100,
  silences: [{ startMs: 1000, endMs: 1500, durationMs: 500 }],
  longestMs: 500,
};

/** A detector that answers with the value. */
function gives<T>(value: T): () => Promise<T> {
  return async () => value;
}

/** A detector that fails with the error. */
function refuses<T>(error: Error): () => Promise<T> {
  return async () => {
    throw error;
  };
}

const refusal = (): EngineError => new EngineError("invalid_input", "the media cannot be decoded", { stage: "media.detectors" });
const outage = (): EngineError => new EngineError("provider", "unreachable", { retryable: true, stage: "media.detectors" });

test("measuredOrNull keeps a result, reads a refused input as missing evidence, and rethrows an outage", async () => {
  assert.equal(await measuredOrNull(async () => 7), 7);
  assert.equal(await measuredOrNull(async () => Promise.reject(refusal())), null);
  await assert.rejects(
    () => measuredOrNull(async () => Promise.reject(outage())),
    (error: unknown) => error instanceof EngineError && error.kind === "provider" && error.retryable,
  );
});

test("the code measures from the detectors equal takeCodeMeasures on the same results (the rule the take gate reads)", () => {
  const measured = codeMeasuresOf({ black: frozenBlack, flicker, motion });
  assert.deepEqual(measured, takeCodeMeasures({ black: frozenBlack, flicker, motion }));
  // A frozen run of 300 ms at 30 fps is nine frames.
  assert.equal(measured.blackOrFrozenRunFrames, 9);
  assert.equal(measured.flickerScore, 0.2);
  assert.equal(measured.meanMotion, 0.1);
});

test("a detector that gave no result is null, and a video with no stream is null, never zero", () => {
  assert.deepEqual(codeMeasuresOf({ black: null, flicker: null, motion: null }), {
    blackOrFrozenRunFrames: null,
    flickerScore: null,
    meanMotion: null,
  });
  const noVideo: FlickerResult = { videoPresent: false, frames: 0, flickerScore: null };
  assert.equal(codeMeasuresOf({ black: cleanBlack, flicker: noVideo, motion: null }).flickerScore, null);
  assert.equal(codeMeasuresOf({ black: cleanBlack, flicker: null, motion: null }).blackOrFrozenRunFrames, 0);
});

test("the take's measurements keep the take's duration and leave a refused detector's measure null", async () => {
  const measurements = await takeMeasurementsFromDetectors(
    { blackFrames: refuses<BlackFramesResult>(refusal()), flicker: gives(flicker), motion: gives(motion) },
    { take: TAKE, bytes: BYTES },
  );
  assert.deepEqual(measurements, { durationMs: 2990, blackOrFrozenRunFrames: null, flickerScore: 0.2, meanMotion: 0.1 });
});

test("a detector outage stops the take measurement, so the job retries and nothing is read as a measurement", async () => {
  await assert.rejects(() =>
    takeMeasurementsFromDetectors(
      { blackFrames: refuses<BlackFramesResult>(outage()), flicker: gives(flicker), motion: gives(motion) },
      { take: TAKE, bytes: BYTES },
    ),
  );
});

test("the render's black frames are read at each required time, and silence is the detector's longest silence", async () => {
  const measured = await renderMeasuresFromDetectors({ blackFrames: gives(blackAtStart), silence: gives(silence) }, { bytes: BYTES, times: [0, 1000] });
  assert.deepEqual(measured.blackFrames, [
    { atMs: 0, black: true },
    { atMs: 1000, black: false },
  ]);
  assert.deepEqual(measured.silence, { longestMs: 500 });
});

test("a render the detectors refuse has no black-frame measure (not evaluated) and no silence (fails closed)", async () => {
  const measured = await renderMeasuresFromDetectors(
    { blackFrames: refuses<BlackFramesResult>(refusal()), silence: refuses<SilenceResult>(refusal()) },
    { bytes: BYTES, times: [0] },
  );
  assert.equal(measured.blackFrames, undefined);
  assert.deepEqual(measured.silence, { longestMs: null });
});

test("graphics clips are judged at their midpoint, keep their box when the EDL sets one, and skip empty spans", () => {
  const edl = {
    tracks: [
      { layer: "base", clips: [{ clipId: "b1", startMs: 0, endMs: 1000 }] },
      {
        layer: "graphics",
        clips: [
          { clipId: "g1", startMs: 1000, endMs: 2000, box: { x: 0.1, y: 0.1, w: 0.5, h: 0.2 } },
          { clipId: "g2", startMs: 3000, endMs: 3000 },
          { clipId: "g3", startMs: 4001, endMs: 5000 },
        ],
      },
    ],
  } as unknown as EditDecisionList;
  assert.deepEqual(graphicsClipsOf(edl), [
    { clipId: "g1", atMs: 1500, box: { x: 0.1, y: 0.1, w: 0.5, h: 0.2 } },
    { clipId: "g3", atMs: 4500 },
  ]);
});
