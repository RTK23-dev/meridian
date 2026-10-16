// The values the take and post-render checks read from the detectors (Bible 6.7 step 1, 12.2, 12.3). Pure. Each function turns a
// validated detector result into the value a gate reads, and returns null wherever the detector could not measure, so the gate
// fails closed (CLAUDE.md working rule 1). No threshold is set here: the consumers read their limits from configuration.

import type {
  BlackFramesResult,
  DetectRun,
  FlickerResult,
  MotionResult,
} from "../../../functions/ffmpeg/types.ts";

/** The take's code measures (review/take/code.ts, TakeMeasurements). Each is null when it was not measured. */
export type TakeCodeMeasures = {
  blackOrFrozenRunFrames: number | null;
  flickerScore: number | null;
  meanMotion: number | null;
};

/**
 * The end of a black run on the timeline. blackdetect reports the first non-black frame's time, which is exclusive, except at
 * the end of the media: there it reports the last black frame's time. A black run that reaches the end is therefore taken to
 * include that last frame (Bible 12.2: a black frame counts).
 */
function blackEndOf(run: DetectRun, durationMs: number | null, frameMs: number): number {
  if (durationMs !== null && run.endMs >= durationMs - frameMs) return run.endMs + frameMs;
  return run.endMs;
}

/** The frame duration in milliseconds, or null when the frame rate is not known. */
function frameMsOf(result: BlackFramesResult): number | null {
  return result.fps === null ? null : 1000 / result.fps;
}

/**
 * The longest run of black or frozen frames, in frames (Bible 12.2: no run over the limit). A frozen run is closed at the
 * media's end by the detector, so it is counted as reported. Null when the video is absent or the frame rate is unknown: a frame
 * count cannot be made without it.
 */
export function longestRunFrames(result: BlackFramesResult): number | null {
  const frameMs = frameMsOf(result);
  if (!result.videoPresent || result.fps === null || frameMs === null) return null;
  const black = result.blackRuns.map(
    (run) => blackEndOf(run, result.durationMs, frameMs) - run.startMs,
  );
  const frozen = result.frozenRuns.map((run) => run.endMs - run.startMs);
  const longestMs = [...black, ...frozen].reduce((most, ms) => Math.max(most, ms), 0);
  return Math.round((longestMs * result.fps) / 1000);
}

/** The code measures of one take, from its black, flicker and motion detectors. */
export function takeCodeMeasures(input: {
  black: BlackFramesResult;
  flicker: FlickerResult;
  motion: MotionResult;
}): TakeCodeMeasures {
  return {
    blackOrFrozenRunFrames: longestRunFrames(input.black),
    flickerScore: input.flicker.videoPresent ? input.flicker.flickerScore : null,
    meanMotion: input.motion.videoPresent ? input.motion.meanMotion : null,
  };
}

/**
 * Whether the frame at atMs is black (Bible 12.3, black frames at the cuts and the sample positions). Null when the video is
 * absent, the duration is unknown, or the time is past the end of the media.
 */
export function blackAt(result: BlackFramesResult, atMs: number): boolean | null {
  if (!result.videoPresent || result.durationMs === null || atMs >= result.durationMs) return null;
  const frameMs = frameMsOf(result) ?? 0;
  return result.blackRuns.some(
    (run) => run.startMs <= atMs && atMs < blackEndOf(run, result.durationMs, frameMs),
  );
}

/** The black-frame measurement of each time, as the post-render review reads it. */
export function blackFrameMeasures(
  result: BlackFramesResult,
  timesMs: readonly number[],
): Array<{ atMs: number; black: boolean | null }> {
  return timesMs.map((atMs) => ({ atMs, black: blackAt(result, atMs) }));
}
