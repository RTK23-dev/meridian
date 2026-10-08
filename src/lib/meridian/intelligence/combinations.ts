/**
 * 11-Dimensional Angle Bible Combinations
 *
 * Systematically generates, evaluates, and deduplicates creative pattern combinations across
 * the 11 core dimensions of modern short-form performance creative.
 */

import { createHash } from "node:crypto";

export type AngleDimensions = {
  hookMechanism: string;
  openingMove: string;
  format: string;
  pacing: string;
  tone: string;
  visualStyle: string;
  proofMechanism: string;
  audienceSegment: string;
  problemFraming: string;
  productRole: string;
  callToAction: string;
};

export type PatternCombination = {
  combinationHash: string;
  dimensions: AngleDimensions;
  saturationCount: number;
  fatigueRisk: number; // 0 to 1
  theoreticalNovelty: number; // 0 to 1
};

export const CORE_DIMENSION_VOCABULARY = {
  hookMechanism: [
    "curiosity",
    "pain_point",
    "contrast",
    "aspiration",
    "proof",
    "urgency",
    "humor",
    "authority",
    "demonstration",
    "offer",
  ],
  openingMove: [
    "question",
    "problem",
    "bold_claim",
    "story",
    "demonstration",
    "product_first",
    "offer_first",
    "social_proof",
  ],
  format: ["ugc", "demo", "testimonial", "listicle", "skit", "unboxing", "comparison"],
  pacing: ["fast_cuts", "steady", "slow_deliberate", "dynamic"],
  tone: ["authoritative", "conversational", "energetic", "empathetic", "skeptical", "irreverent"],
  visualStyle: ["raw_phone", "studio_clean", "lo_fi", "macro_texture", "split_screen"],
  proofMechanism: [
    "split_screen_before_after",
    "microscopic_view",
    "clinical_data",
    "customer_quote",
    "demo_live",
  ],
  audienceSegment: [
    "problem_aware",
    "solution_seeking",
    "skeptical_switcher",
    "impulse_buyer",
    "budget_conscious",
  ],
  problemFraming: [
    "hidden_cause",
    "common_mistake",
    "sudden_breakdown",
    "chronic_frustration",
    "social_embarrassment",
  ],
  productRole: ["hero_solution", "secret_weapon", "daily_habit", "emergency_fix", "replacement"],
  callToAction: ["direct_buy", "discount_code", "limited_drop", "quiz_lead", "comparison_page"],
} as const;

export function computeCombinationHash(dim: AngleDimensions): string {
  const serialized = [
    dim.hookMechanism,
    dim.openingMove,
    dim.format,
    dim.pacing,
    dim.tone,
    dim.visualStyle,
    dim.proofMechanism,
    dim.audienceSegment,
    dim.problemFraming,
    dim.productRole,
    dim.callToAction,
  ].join("|");
  return createHash("sha256").update(serialized).digest("hex");
}

export function generatePatternCombination(
  overrides: Partial<AngleDimensions> = {},
): PatternCombination {
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]!;

  const dimensions: AngleDimensions = {
    hookMechanism: overrides.hookMechanism || pick(CORE_DIMENSION_VOCABULARY.hookMechanism),
    openingMove: overrides.openingMove || pick(CORE_DIMENSION_VOCABULARY.openingMove),
    format: overrides.format || pick(CORE_DIMENSION_VOCABULARY.format),
    pacing: overrides.pacing || pick(CORE_DIMENSION_VOCABULARY.pacing),
    tone: overrides.tone || pick(CORE_DIMENSION_VOCABULARY.tone),
    visualStyle: overrides.visualStyle || pick(CORE_DIMENSION_VOCABULARY.visualStyle),
    proofMechanism: overrides.proofMechanism || pick(CORE_DIMENSION_VOCABULARY.proofMechanism),
    audienceSegment: overrides.audienceSegment || pick(CORE_DIMENSION_VOCABULARY.audienceSegment),
    problemFraming: overrides.problemFraming || pick(CORE_DIMENSION_VOCABULARY.problemFraming),
    productRole: overrides.productRole || pick(CORE_DIMENSION_VOCABULARY.productRole),
    callToAction: overrides.callToAction || pick(CORE_DIMENSION_VOCABULARY.callToAction),
  };

  const hash = computeCombinationHash(dimensions);

  return {
    combinationHash: hash,
    dimensions,
    saturationCount: 0,
    fatigueRisk: 0.1,
    theoreticalNovelty: 0.85,
  };
}
