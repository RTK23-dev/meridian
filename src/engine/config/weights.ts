// Scoring weights (Bible 7.5 visual-type score and 10.2 provider score). Learned nightly (16.2), so tuned.

import { tunable } from "./tunable.ts";

export const weights = {
  version: "weights@1",

  // 7.5: U(s, t) = 0.30 beatFit + 0.20 referenceMatch + 0.15 styleFit + 0.15 winRate
  //      - 0.10 costShare - 0.10 artifactRisk + 0.05 continuity - 0.05 repetition.
  // The subtracted terms are stored as positive magnitudes.
  visualScore: {
    beatFit: tunable(0.3, 0, 1),
    referenceMatch: tunable(0.2, 0, 1),
    styleFit: tunable(0.15, 0, 1),
    winRate: tunable(0.15, 0, 1),
    costShare: tunable(0.1, 0, 1),
    artifactRisk: tunable(0.1, 0, 1),
    continuity: tunable(0.05, 0, 1),
    repetition: tunable(0.05, 0, 1),
  },

  // 7.5: winRate uses this prior until 30 samples.
  winRatePrior: tunable(0.5, 0, 1),
  winRateMinSamples: 30,

  // 7.4 and 7.5: reference match by proposal order (first, second, others). Structural, constants.
  referenceMatchByOrder: { first: 1, second: 0.6, other: 0.3 },

  // 7.5: repetition counts the same type this many shots running.
  repetitionRunLength: 3,

  // 10.2: provider score for each eligible adapter. Initial weights sum to 1.00.
  providerScore: {
    taskFit: tunable(0.3, 0, 1),
    outputQuality: tunable(0.2, 0, 1),
    control: tunable(0.15, 0, 1),
    reliability: tunable(0.15, 0, 1),
    costEfficiency: tunable(0.1, 0, 1),
    latency: tunable(0.05, 0, 1),
    continuity: tunable(0.05, 0, 1),
  },
} as const;
