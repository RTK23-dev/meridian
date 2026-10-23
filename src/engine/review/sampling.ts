// Sampling after delivery (Video Engine Bible 6.14, 12.5). A delivered video is sampled for a person to review: 100% of a format's videos
// until 50 pass in a row, then 5% at random. A gate threshold change resets the sampling for that format to 20% for a week, and the pass
// count starts again. A sampled video becomes a review item after delivery; delivery never waits for it.
//
// Pure: the policy decides, and the state is data. The draw is a hash of the request and the video, so a retried delivery samples the same
// videos and queues each item once. The store and the deliver step live elsewhere (jobs/sampling-store.ts, jobs/handlers/deliver.ts).

import { createHash } from "node:crypto";

/** The sampling constants of Bible 6.14 and 12.5. Changing one is a Bible change. */
export const SAMPLING = {
  /** A format is sampled at every video until this many passes in a row. */
  passesToLeaveNewFormat: 50,
  newFormatRate: 1,
  steadyRate: 0.05,
  /** The rate for the week after a gate threshold change. */
  resetRate: 0.2,
  resetDays: 7,
} as const;

export type SamplingState = {
  /** Accepted sampled videos in a row. A reject, or a threshold change, starts the count again. */
  consecutivePasses: number;
  /** The threshold version the format last saw, or null before its first delivery. */
  thresholdVersion: string | null;
  /** When the reset week ends, or null when no reset is running. */
  resetUntil: string | null;
};

export const EMPTY_SAMPLING_STATE: SamplingState = { consecutivePasses: 0, thresholdVersion: null, resetUntil: null };

/**
 * The state after the thresholds in force are known. A format's first delivery records its version without a reset, because nothing was
 * sampled under another version. A later change of version starts the reset week and the pass count again.
 */
export function withThresholdVersion(state: SamplingState, version: string, now: string): SamplingState {
  if (state.thresholdVersion === null) return { ...state, thresholdVersion: version };
  if (state.thresholdVersion === version) return state;
  const resetUntil = new Date(Date.parse(now) + SAMPLING.resetDays * 86_400_000).toISOString();
  return { consecutivePasses: 0, thresholdVersion: version, resetUntil };
}

/** The rate for the next delivered video of the format: the reset rate during a reset week, otherwise 100% until 50 passes, then 5%. */
export function samplingRateOf(state: SamplingState, now: string): number {
  if (state.resetUntil !== null && Date.parse(now) < Date.parse(state.resetUntil)) return SAMPLING.resetRate;
  return state.consecutivePasses < SAMPLING.passesToLeaveNewFormat ? SAMPLING.newFormatRate : SAMPLING.steadyRate;
}

/** Whether one video is sampled at this rate: a fixed draw per request and video, so a retry draws the same. */
export function isSampled(draw: { requestId: string; videoId: string }, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  const digest = createHash("sha256").update(`${draw.requestId}|${draw.videoId}`).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000 < rate;
}

/**
 * A human decision on a sampled video. An accept is a pass in a row. A reject starts the count again. Any other action on a video (it
 * changes the plan, not the video's acceptance) leaves the count as it is.
 */
export function afterSampleDecision(state: SamplingState, action: string): SamplingState {
  if (action === "accept") return { ...state, consecutivePasses: state.consecutivePasses + 1 };
  if (action === "reject") return { ...state, consecutivePasses: 0 };
  return state;
}
