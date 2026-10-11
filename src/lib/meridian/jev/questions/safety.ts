/**
 * JEV Question Registry: Safety, Claims & Rights Questions
 *
 * Verifies regulatory compliance, prohibited claims, trademark/copyright risks,
 * and surface copying hazards.
 */

import type { JevQuestionSpec } from "../types.ts";

export const SAFETY_QUESTIONS: Record<string, JevQuestionSpec> = {
  "safety.claim_compliance.v1": {
    id: "safety.claim_compliance.v1",
    version: "1.0.0",
    type: "noul",
    instructions: "Does the script strictly avoid unsubstantiated claims, prohibited medical/financial promises, and deceptive guarantees?",
    criteria: {
      true: "All claims are strictly within approved brand facts and supported by clear disclaimers.",
      false: "Contains unapproved medical cure claims, guaranteed financial returns, or prohibited claims.",
    },
    evidenceRequirements: ["script", "brand_allowed_claims"],
    policyMapping: {
      approveMinProbability: 0.95,
      reviewMinProbability: 0.80,
    },
  },

  "safety.rights_and_originality.v1": {
    id: "safety.rights_and_originality.v1",
    version: "1.0.0",
    type: "noul",
    instructions: "Does this concept safely reuse underlying psychological mechanisms without copying proprietary third-party scripts, character IP, or protected audio?",
    criteria: {
      true: "Mechanism and structure are reused with entirely novel scripts, visuals, and brand assets.",
      false: "Copies recognizable competitor phrasing, verbatim dialog, copyrighted characters, or protected audio.",
    },
    evidenceRequirements: ["script", "source_reference"],
    policyMapping: {
      approveMinProbability: 0.92,
      reviewMinProbability: 0.70,
    },
  },

  "safety.policy_risk_level.v1": {
    id: "safety.policy_risk_level.v1",
    version: "1.0.0",
    type: "choice",
    instructions: "Classify platform policy risk across Meta, TikTok, and YouTube guidelines.",
    criteria: {
      zero_risk: "Completely standard, compliant narrative with zero policy sensitivities.",
      low_risk: "Slight edge or provocative question well within community guidelines.",
      moderate_risk_review: "Sensory close-ups or bold comparisons that might trigger automated review flags.",
      severe_risk_prohibited: "Violates advertising policies: before/after body shaming, deceptive framing, banned substances.",
    },
    evidenceRequirements: ["script", "concept_spec"],
    policyMapping: {
      rejectionValues: ["severe_risk_prohibited"],
    },
  },
};

/**
 * The evidence each research safety question may receive (GateQuestion.evidenceScope). Each scope is the question's requirements,
 * plus bundle_source (the bundle's identity, source, and platform). The research bundle does not supply `script`,
 * `brand_allowed_claims`, `source_reference`, or `concept_spec`, so these questions abstain and go to human review until a source
 * supplies them. Nothing here is inferred from other evidence.
 */
export const SAFETY_EVIDENCE_SCOPES: Record<string, readonly string[]> = {
  "safety.claim_compliance.v1": ["bundle_source", "script", "brand_allowed_claims"],
  "safety.rights_and_originality.v1": ["bundle_source", "script", "source_reference"],
  "safety.policy_risk_level.v1": ["bundle_source", "script", "concept_spec"],
};
