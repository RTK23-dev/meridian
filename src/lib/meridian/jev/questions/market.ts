/**
 * JEV Question Registry: Market Questions
 *
 * Whether the creatives a brand has stored from its competitors leave an opening the brand has not used. Asked of the active
 * decision engine through the engine gate (decisions/gate.ts). The Factory grade asks it for each graded ad.
 *
 * The thresholds are not calibrated. They stay uncalibrated until a calibration report says otherwise, so every probability
 * this question returns goes to human review. Nothing it returns can approve or reject a creative.
 */

import type { JevQuestionSpec } from "../types.ts";

export const MARKET_QUESTIONS: Record<string, JevQuestionSpec> = {
  "market.competitive_strength.v1": {
    id: "market.competitive_strength.v1",
    version: "1.0.0",
    type: "noul",
    instructions:
      "From the counts of stored competitor creatives and of this brand's own creatives, does this angle leave an opening the brand has not already used? Judge only the counts given.",
    criteria: {
      true: "Competitors use this angle in a minority of their stored creatives, and this brand uses it little or not at all.",
      false: "Competitors saturate this angle in their stored creatives, or this brand already uses it heavily.",
    },
    evidenceRequirements: ["competitor_creatives", "brand_creatives"],
    policyMapping: {
      predicateDirection: "pass_if_true",
      // Uncalibrated. These are the opportunity thresholds in jev/questions.ts, which no calibration report has confirmed.
      approveMinProbability: 0.88,
      reviewMinProbability: 0.28,
      thresholdCalibration: "uncalibrated",
    },
  },
};
