/**
 * JEV Question Registry: Creator Intelligence Questions
 *
 * Evaluates creator baseline, outlier status, stylistic repeatability,
 * and small-creator breakouts against comparison sets.
 */

import type { JevQuestionSpec } from "../types.ts";

export const CREATOR_QUESTIONS: Record<string, JevQuestionSpec> = {
  "creator.outlier_significance.v1": {
    id: "creator.outlier_significance.v1",
    version: "1.0.0",
    type: "noul",
    instructions: "Given the creator's median views baseline, is this Reel a statistically genuine performance outlier rather than random variance?",
    criteria: {
      true: "Views exceed creator median by at least 3x with heightened velocity and share ratio.",
      false: "Views are within normal creator distribution or driven solely by external promotion.",
    },
    evidenceRequirements: ["creator_baseline", "performance_snapshot"],
    policyMapping: {
      approveMinProbability: 0.80,
      reviewMinProbability: 0.50,
    },
  },

  "creator.breakout_type.v1": {
    id: "creator.breakout_type.v1",
    version: "1.0.0",
    type: "choice",
    instructions: "Categorize the primary driver of the creator's breakout performance.",
    criteria: {
      mechanism_driven: "Breakout is driven by novel framing, hook, or demonstration accessible to others.",
      personality_driven: "Breakout stems entirely from creator's personal charisma or established celebrity.",
      trending_audio_boost: "Breakout is primarily an audio meme ride without unique creative merit.",
      controversy_ragebait: "Breakout is fueled by intentional error, outrage, or provocative claims.",
    },
    evidenceRequirements: ["creator_baseline", "transcript", "performance_snapshot"],
  },

  "creator.repeatability.v1": {
    id: "creator.repeatability.v1",
    version: "1.0.0",
    type: "score",
    instructions: "Rate the repeatable craft consistency of this creator across their catalog (1 to 5).",
    criteria: [
      "1: One-hit wonder; rest of catalog shows erratic quality and near-zero engagement.",
      "2: Sporadic performance with rare occasional hits.",
      "3: Consistent baseline with predictable engagement within their niche.",
      "4: High craft mastery; repeatedly engineers above-median performers.",
      "5: Elite systematic creator producing recurring outliers through clear formulas.",
    ],
    evidenceRequirements: ["creator_baseline"],
  },
};
