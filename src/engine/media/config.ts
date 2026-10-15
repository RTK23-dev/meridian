// Media settings that the Bible marks initial (sections 6.2, 15.2). They live here, not in engine/config, because the
// config folder belongs to eng-contracts. The lead should move sceneCutScore into engine/config/thresholds.ts (see
// STATUS.md). Logic reads these values; no number is hard-coded in the clients.

import { tunable } from "../config/tunable.ts";

export const mediaConfig = {
  version: "media@1",

  /** Scene-cut score T for select='gt(scene,T)' (Bible 6.2). Tuned from the gold sets once they exist. */
  sceneCutScore: tunable(0.3, 0.1, 0.9),

  /** The EDL frame rate (Bible 8.2). One frame in milliseconds, used to place frames and to dedupe them. */
  frameMs: 1000 / 30,

  /**
   * Transport timeouts for one call to a deployed function, in milliseconds. Each is longer than the function's own
   * tool timeout (functions/ffmpeg/limits.ts) so that a cold start (about 3 s, Bible 15.2) does not cut the call short.
   */
  callTimeoutMs: {
    probe: 40_000,
    frames: 80_000,
    loudness: 140_000,
    cuts: 140_000,
    timeline: 300_000,
    picture: 200_000,
  },

  /** Validation limits for speech-to-text output (untrusted, Bible 2 and 6.3). */
  transcript: {
    maxWords: 3000,
    maxWordChars: 64,
    /** A word may end this many milliseconds after the audio ends (rounding and encoder padding). */
    endToleranceMs: 500,
  },
} as const;
