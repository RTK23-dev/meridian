/**
 * Parameter Calibration Registry
 * Enforces explicit separation between heuristic "seed priors" and statistically "fitted weights".
 * Prevents unverified claims of "calibrated" models until empirical evidence confirms them.
 */

export type ParameterOrigin = "seed_prior" | "fitted_weight";

export interface CalibratedParameter<T = number> {
  value: T;
  origin: ParameterOrigin;
  sampleCount: number;
  lastUpdated: string;
  sourceNote: string;
}

/**
 * Creates a Seed Prior: an expert-defined initial heuristic.
 */
export function seedPrior<T = number>(value: T, sourceNote: string): CalibratedParameter<T> {
  return {
    value,
    origin: "seed_prior",
    sampleCount: 0,
    lastUpdated: "2026-10-07T00:00:00Z",
    sourceNote,
  };
}

/**
 * Creates a Fitted Weight: calibrated from real observed performance.
 */
export function fittedWeight<T = number>(
  value: T,
  sampleCount: number,
  sourceNote: string,
): CalibratedParameter<T> {
  return {
    value,
    origin: "fitted_weight",
    sampleCount,
    lastUpdated: new Date().toISOString(),
    sourceNote,
  };
}

/**
 * Default Seed Priors for JEV and Content Factory.
 * Explicitly marked as seed_prior until calibrated by account outcomes.
 */
export const SEED_PRIORS = {
  hookRetentionBetas: {
    motion: seedPrior(0.35, "Initial heuristic baseline for first 1.5s motion intensity"),
    facePresence: seedPrior(0.25, "Initial heuristic baseline for talking head face presence"),
    typographyClarity: seedPrior(0.20, "Initial heuristic baseline for text readability"),
    audioEnergy: seedPrior(0.20, "Initial heuristic baseline for speech and music onset"),
  },
  speechProsodyWpm: {
    sweetSpotMin: seedPrior(140, "Initial heuristic lower bound for short-form speech pace"),
    sweetSpotMax: seedPrior(185, "Initial heuristic upper bound for short-form speech pace"),
  },
  nicheBaselineViews: {
    dtcBeauty: seedPrior(15000, "Initial niche median views estimate"),
    fitnessApps: seedPrior(12000, "Initial niche median views estimate"),
    consumerSaas: seedPrior(8000, "Initial niche median views estimate"),
    general: seedPrior(10000, "Initial generic niche median views estimate"),
  },
};
