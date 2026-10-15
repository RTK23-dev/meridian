// The measurements the gates read, taken from the media detectors (Bible 6.7 step 1, 12.2, 12.3). The detectors are the
// media functions' black, flicker, motion and silence routes (media/interface.ts, MediaDetectors). This file calls them on the
// bytes of a take or of a rendered video and turns each result into the value its gate reads, through the pure functions in
// media/measures.ts. Nothing is guessed: a detector that refuses its input (invalid_input, for example a file it cannot decode)
// gives null for its measure, so the gate that reads it fails closed. Any other failure (a provider outage, a timeout) throws,
// so the job retries it (Bible 5.1). No threshold is set here.

import { EngineError, type Take } from "../contracts/index.ts";
import type { TakeMeasurements } from "../review/take/code.ts";
import type { SilenceMeasurement } from "../review/gates/postRender.ts";
import type { MediaDetectors, BlackFramesResult, FlickerResult, MotionResult, SilenceResult } from "../media/interface.ts";
import { blackFrameMeasures, longestRunFrames, type TakeCodeMeasures } from "../media/measures.ts";

/** The detectors a take check reads (Bible 6.7 step 1). */
export type TakeDetectors = Pick<MediaDetectors, "blackFrames" | "flicker" | "motion">;

/** The detectors a rendered video's review reads (Bible 6.12, 12.3): black frames and silence. */
export type RenderDetectors = Pick<MediaDetectors, "blackFrames" | "silence">;

/**
 * The result of one detector call, or null when the detector refused the input (invalid_input: the media cannot be read).
 * A null is missing evidence. Every other error propagates, so an outage is retried, never read as a measurement.
 */
export async function measuredOrNull<Result>(call: () => Promise<Result>): Promise<Result | null> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof EngineError && error.kind === "invalid_input") return null;
    throw error;
  }
}

/**
 * The code measures of one take from the detectors (Bible 6.7 step 1): the longest black or frozen run in frames, the flicker
 * score and the mean motion, with the duration the take's probe gave. Each value mirrors takeCodeMeasures (media/measures.ts):
 * a measure that is absent or not measured is null. The take's duration is kept from the Take artifact.
 */
export async function takeMeasurementsFromDetectors(
  detectors: TakeDetectors,
  input: { take: Pick<Take, "durationMs">; bytes: Uint8Array<ArrayBuffer> },
): Promise<TakeMeasurements> {
  const source = { kind: "bytes" as const, bytes: input.bytes };
  const black: BlackFramesResult | null = await measuredOrNull(() => detectors.blackFrames({ source }));
  const flicker: FlickerResult | null = await measuredOrNull(() => detectors.flicker({ source }));
  const motion: MotionResult | null = await measuredOrNull(() => detectors.motion({ source }));
  return {
    durationMs: input.take.durationMs,
    ...codeMeasuresOf({ black, flicker, motion }),
  };
}

/** The three take code values from the three detector results, each null when its detector gave no result. */
export function codeMeasuresOf(results: {
  black: BlackFramesResult | null;
  flicker: FlickerResult | null;
  motion: MotionResult | null;
}): TakeCodeMeasures {
  return {
    blackOrFrozenRunFrames: results.black === null ? null : longestRunFrames(results.black),
    flickerScore: results.flicker === null || !results.flicker.videoPresent ? null : results.flicker.flickerScore,
    meanMotion: results.motion === null || !results.motion.videoPresent ? null : results.motion.meanMotion,
  };
}

/**
 * The black-frame measure at each required time, and the silence of a rendered video (Bible 12.3). Black frames are null per
 * time when the detector refused the file; silence is null when the audio could not be measured.
 */
export async function renderMeasuresFromDetectors(
  detectors: RenderDetectors,
  input: { bytes: Uint8Array<ArrayBuffer>; times: readonly number[] },
): Promise<{
  blackFrames: Array<{ atMs: number; black: boolean | null }> | undefined;
  silence: SilenceMeasurement;
}> {
  const source = { kind: "bytes" as const, bytes: input.bytes };
  const black: BlackFramesResult | null = await measuredOrNull(() => detectors.blackFrames({ source }));
  const silence: SilenceResult | null = await measuredOrNull(() => detectors.silence({ source }));
  return {
    blackFrames: black === null ? undefined : blackFrameMeasures(black, input.times),
    silence: { longestMs: silence === null ? null : silence.longestMs },
  };
}
