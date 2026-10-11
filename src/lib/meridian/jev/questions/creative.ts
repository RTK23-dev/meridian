/**
 * JEV Question Registry: Creative Judgments
 *
 * Semantic checks on a generated or brief-driven creative, asked of the active decision engine through the engine gate
 * (decisions/gate.ts). Each question names the evidence it needs. A question that needs an image is refused when the
 * active engine cannot see images, and it is never answered from the text alone.
 *
 * Deterministic checks stay out of this file: literal prohibited phrases, avoided words, measured logo and palette,
 * exact and near duplicates, and competitor overlap are decided locally and can reject without any engine call.
 */

import type { JevQuestionSpec } from "../types.ts";

export const CREATIVE_QUESTIONS: Record<string, JevQuestionSpec> = {
  "creative.brand_fit.v1": {
    id: "creative.brand_fit.v1",
    version: "1.0.0",
    type: "noul",
    instructions:
      "Does this creative express the brand's stated positioning for the angle it claims? Judge the meaning of the copy against the positioning, not shared keywords.",
    criteria: {
      true: "The creative expresses the stored positioning for its stated angle.",
      false: "The creative contradicts the stored positioning or argues for a different one.",
    },
    evidenceRequirements: ["creative_copy", "brand_positioning"],
    policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.85, reviewMinProbability: 0.6 },
  },

  "creative.opportunity_fit.v1": {
    id: "creative.opportunity_fit.v1",
    version: "1.0.0",
    type: "noul",
    instructions: "Does the copy deliver the angle the opportunity names, in its own content, rather than only mentioning it?",
    criteria: {
      true: "The copy delivers the named angle.",
      false: "The copy does not deliver the named angle.",
    },
    evidenceRequirements: ["creative_copy", "opportunity_angle"],
    policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.85, reviewMinProbability: 0.6 },
  },

  "creative.claim_compliance.v1": {
    id: "creative.claim_compliance.v1",
    version: "1.0.0",
    type: "noul",
    instructions:
      "Does the copy avoid claims beyond the brand's stored claims and the prohibited list? Include implied claims and guarantees, not only the literal wording.",
    criteria: {
      true: "Every claim in the copy is within the brand's stored claims.",
      false: "The copy makes a claim outside the stored claims, or implies a guarantee.",
    },
    evidenceRequirements: ["creative_copy", "brand_prohibited_claims"],
    policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.95, reviewMinProbability: 0.8 },
  },

  "creative.visual_quality.v1": {
    id: "creative.visual_quality.v1",
    version: "1.0.0",
    type: "noul",
    instructions:
      "Is the image free of visible defects that would make it unfit to publish: garbled or distorted text, malformed objects or hands, obvious artifacts, or an unreadable composition?",
    criteria: {
      true: "No visible defect makes the image unfit to publish.",
      false: "A visible defect makes the image unfit to publish.",
    },
    evidenceRequirements: ["image"],
    perceptionEvidence: { contract: "visual_quality", version: "1.0.0" },
    policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.9, reviewMinProbability: 0.7 },
  },

  "creative.product_visible.v1": {
    id: "creative.product_visible.v1",
    version: "1.0.0",
    type: "noul",
    instructions: "Is the stored product clearly visible and identifiable in the image, rather than only implied or absent?",
    criteria: {
      true: "The product is clearly visible and identifiable.",
      false: "The product is absent, hidden, or not identifiable.",
    },
    evidenceRequirements: ["image", "product_name"],
    perceptionEvidence: { contract: "product_visibility", version: "1.0.0" },
    policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.85, reviewMinProbability: 0.6 },
  },
};

/**
 * The evidence each creative question may receive (GateQuestion.evidenceScope). Scope names:
 * - creative_copy: the creative's own copy. transcript: its spoken words, for a video. Both reach the three text questions.
 * - brand_positioning, brand_prohibited_claims, opportunity_angle, product_name: the brand and opportunity facts a question
 *   judges against. Each text question receives only the one it judges against.
 * - image: every image item the gate was given. visual_coverage: how much of the creative was analysed.
 * The text questions never receive an image or a perception observation. A visual question under OpenAI Decisions receives
 * the image; under JEV, which cannot see images, the image scope is replaced by perception_observations (image-qc.server.ts).
 */
export const CREATIVE_EVIDENCE_SCOPES: Record<string, readonly string[]> = {
  "creative.brand_fit.v1": ["creative_copy", "transcript", "brand_positioning"],
  "creative.opportunity_fit.v1": ["creative_copy", "transcript", "opportunity_angle"],
  "creative.claim_compliance.v1": ["creative_copy", "transcript", "brand_prohibited_claims"],
  "creative.visual_quality.v1": ["image", "visual_coverage"],
  "creative.product_visible.v1": ["image", "visual_coverage", "product_name"],
};
