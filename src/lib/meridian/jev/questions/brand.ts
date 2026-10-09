/**
 * JEV Question Registry: Brand & Positioning Questions
 *
 * Evaluates brand fit beyond simple keyword overlap:
 * positioning expression, audience recognition, persona compatibility,
 * natural product entry, and tone harmony.
 */

import type { JevQuestionSpec } from "../types.ts";

export const BRAND_QUESTIONS: Record<string, JevQuestionSpec> = {
  "brand.positioning_fit.v1": {
    id: "brand.positioning_fit.v1",
    version: "1.0.0",
    type: "noul",
    instructions: "Does this concept align with and clearly express the brand's stated core positioning without diluting brand equity?",
    criteria: {
      true: "Reinforces primary value proposition, target customer persona, and category definition.",
      false: "Contradicts brand identity, targets completely foreign demographic, or damages positioning.",
    },
    evidenceRequirements: ["brand_brain", "concept_spec"],
    policyMapping: {
      approveMinProbability: 0.85,
      reviewMinProbability: 0.60,
    },
  },

  "brand.product_integration_naturalness.v1": {
    id: "brand.product_integration_naturalness.v1",
    version: "1.0.0",
    type: "choice",
    instructions: "Evaluate how naturally the brand's product enters the narrative arc.",
    criteria: {
      organic_catalyst: "Product is the organic resolution to the dilemma established in the hook.",
      ambient_presence: "Product is actively used or visible naturally without forced infomercial sales talk.",
      bolted_on_cta: "Product has no logical connection to video until a jarring abrupt pitch at the end.",
      distracting_centerpiece: "Product is aggressively shoved into camera ruining narrative immersion.",
    },
    evidenceRequirements: ["concept_spec"],
    policyMapping: {
      rejectionValues: ["bolted_on_cta", "distracting_centerpiece"],
    },
  },

  "brand.tone_harmony.v1": {
    id: "brand.tone_harmony.v1",
    version: "1.0.0",
    type: "score",
    instructions: "Rate how well the proposed script and visual atmosphere reflect the brand's defined voice and vocabulary (1 to 5).",
    criteria: [
      "1: Complete dissonance; inappropriate slang, off-brand hostility, or discordant aesthetic.",
      "2: Poor fit; uses banned brand words or mismatched level of formality.",
      "3: Acceptable baseline; neutral tone without major brand conflicts.",
      "4: Strong harmony; accurately captures brand personality and authentic vocabulary.",
      "5: Exceptional resonance; embodies the quintessential brand voice and aesthetic standard.",
    ],
    evidenceRequirements: ["brand_brain", "script"],
    policyMapping: {
      approveMinProbability: 0.75,
      reviewMinProbability: 0.50,
    },
  },
};
