// Settings of the voice stage (Bible 6.3). The retry count for paces comes from thresholds.voice (paceRetries), and the word
// error rate limit from thresholds.voice (wordErrorRateMax). The speeds and the retake and tighten limits are initial values
// (Bible 16.2) and live here until eng-contracts moves them into engine/config (see voice/STATUS.md).

export const voiceConfig = {
  version: "voice@1",
  /** Faster paces, tried in turn when the narration is over maxMs. One entry per pace retry (thresholds.voice.paceRetries). */
  paceSpeeds: [1.1, 1.2] as const,
  /** Retakes of the same text when the transcript differs from the script beyond the word error rate (initial). */
  retakesMax: 1,
  /** Tightenings of the longest beat when the narration is still over maxMs after the faster paces (initial). */
  tightenMax: 1,
};
