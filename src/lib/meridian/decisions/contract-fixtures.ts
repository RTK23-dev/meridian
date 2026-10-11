/**
 * Provider-neutral fixtures shared by the contract tests of every decision engine.
 *
 * The questions are one predicate, one choice, and one score, in the registry's shape. Each engine's test builds its
 * own provider response from the same expected values, so a difference in behaviour between engines shows up as a
 * failing test rather than as a silent divergence.
 */
import type { JevQuestionSpec } from "../jev/types.ts";
import type { DecisionRequest } from "./types.ts";

export const CONTRACT_PREDICATE: JevQuestionSpec = {
  id: "brand.positioning_fit.v1",
  version: "1.0.0",
  type: "noul",
  instructions: "Does this concept reinforce the brand's stated positioning?",
  criteria: { true: "Reinforces the positioning.", false: "Contradicts the positioning." },
  evidenceRequirements: [],
};

export const CONTRACT_CHOICE: JevQuestionSpec = {
  id: "brand.product_integration_naturalness.v1",
  version: "1.0.0",
  type: "choice",
  instructions: "Evaluate how naturally the product enters the narrative.",
  criteria: {
    organic_catalyst: "The product resolves the problem set up in the hook.",
    bolted_on_cta: "The product is pitched abruptly at the end.",
  },
  evidenceRequirements: [],
};

export const CONTRACT_SCORE: JevQuestionSpec = {
  id: "brand.tone_harmony.v1",
  version: "1.0.0",
  type: "score",
  instructions: "Rate how well the tone matches the brand voice (1 to 5).",
  criteria: [
    "1: Complete dissonance.",
    "2: Poor fit.",
    "3: Acceptable baseline.",
    "4: Strong harmony.",
    "5: Exceptional resonance.",
  ],
  evidenceRequirements: [],
};

export const CONTRACT_QUESTIONS: Record<string, JevQuestionSpec> = {
  positioning: CONTRACT_PREDICATE,
  naturalness: CONTRACT_CHOICE,
  tone: CONTRACT_SCORE,
};

/** Answers are keyed by the caller's question key, not by the registry id. */
export const CONTRACT_KEYS = { predicate: "positioning", choice: "naturalness", score: "tone" } as const;

/** Expected values, shared by both engines' tests. */
export const CONTRACT_EXPECTED = {
  predicateProbability: 0.91,
  choiceValue: "organic_catalyst",
  choiceConfidence: 0.8,
  scoreIndex: 3.4,
  scoreLevelLabels: ["1", "2", "3", "4", "5"],
} as const;

/** A PNG signature followed by padding. It passes the strict magic-byte check, which is all the adapter validates. */
export function contractPngBytes(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return bytes;
}

export function contractRequest(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    organizationId: "org-contract",
    brandId: "brand-contract",
    state: {
      description: "A 15-second kitchen demo.",
      bundleId: "bundle-contract",
      availableEvidence: [],
      transcriptSummary: "Shows the sponge lifting grease.",
    },
    questions: CONTRACT_QUESTIONS,
    ...overrides,
  };
}
