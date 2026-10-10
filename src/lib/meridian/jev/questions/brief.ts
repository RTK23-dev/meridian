/**
 * JEV Question Registry: Brief Judgments
 *
 * Semantic checks on a brief, asked of the active decision engine through the brief gate (studio/brief-gate.server.ts).
 * Mechanical checks stay local: mandatory fields present, and no stored prohibited claim in the brief text.
 */

import type { JevQuestionSpec } from "../types.ts";

export const BRIEF_QUESTIONS: Record<string, JevQuestionSpec> = {
  "brief.brand_fit.v1": {
    id: "brief.brand_fit.v1",
    version: "1.0.0",
    type: "noul",
    instructions:
      "Does this brief direct a creative that expresses the brand's stated positioning and tone for its angle? Judge the meaning of the brief against the positioning, not shared keywords.",
    criteria: {
      true: "The brief directs a creative that expresses the stored positioning and tone.",
      false: "The brief directs a creative that contradicts the stored positioning or tone.",
    },
    evidenceRequirements: ["brief_fields", "brand_positioning"],
    policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.85, reviewMinProbability: 0.6 },
  },

  "brief.opportunity_fit.v1": {
    id: "brief.opportunity_fit.v1",
    version: "1.0.0",
    type: "noul",
    instructions:
      "Do the brief's hook, message, and call to action deliver its angle as one coherent idea, rather than naming the angle and then doing something else?",
    criteria: {
      true: "The hook, message, and call to action deliver the angle as one idea.",
      false: "The parts of the brief do not deliver the angle as one idea.",
    },
    evidenceRequirements: ["brief_fields", "opportunity_angle"],
    policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.85, reviewMinProbability: 0.6 },
  },

  "brief.claim_compliance.v1": {
    id: "brief.claim_compliance.v1",
    version: "1.0.0",
    type: "noul",
    instructions:
      "Does the brief direct claims only from the brand's stored claims, with no prohibited claim and no implied guarantee? Include implied claims, not only the literal wording.",
    criteria: {
      true: "Every claim the brief directs is within the brand's stored claims.",
      false: "The brief directs a claim outside the stored claims, or implies a guarantee.",
    },
    evidenceRequirements: ["brief_fields", "brand_prohibited_claims"],
    policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.95, reviewMinProbability: 0.8 },
  },
};
