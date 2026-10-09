/**
 * JEV Question Registry: Production Feasibility & Quality Control Questions
 *
 * Preflight checks: prompt completeness, asset availability, production feasibility.
 * Postflight checks: script adherence, hook preservation, brand treatment verification.
 */

import type { JevQuestionSpec } from "../types.ts";

export const PRODUCTION_QUESTIONS: Record<string, JevQuestionSpec> = {
  "production.preflight_readiness.v1": {
    id: "production.preflight_readiness.v1",
    version: "1.0.0",
    type: "noul",
    instructions: "Does the CreativeSpec contain sufficient production specifications (aspect ratio, shot sequence, asset references, constraints) to execute without guessing?",
    criteria: {
      true: "Complete script, visual direction, target platforms, required asset IDs, and timing guidance exist.",
      false: "Critical fields are missing (e.g. no script, unknown target aspect ratio, ambiguous product).",
    },
    evidenceRequirements: ["creative_spec"],
    policyMapping: {
      approveMinProbability: 0.90,
      reviewMinProbability: 0.70,
    },
  },

  "production.postflight_qc.v1": {
    id: "production.postflight_qc.v1",
    version: "1.0.0",
    type: "noul",
    instructions: "Did the generated production artifact faithfully realize the CreativeSpec's intended hook, product presence, and brand safety requirements?",
    criteria: {
      true: "Specified hook is delivered in opening seconds, brand product is accurately visible, and no hallucinated defects.",
      false: "Intended hook is missing, product is distorted or omitted, or output violates brand specifications.",
    },
    evidenceRequirements: ["creative_spec", "artifact_perception"],
    policyMapping: {
      approveMinProbability: 0.88,
      reviewMinProbability: 0.65,
    },
  },

  "production.originality_gate.v1": {
    id: "production.originality_gate.v1",
    version: "1.0.0",
    type: "choice",
    instructions: "Assess output originality against source reference footage.",
    criteria: {
      novel_execution: "Original media, custom visuals, unique wording; borrows only abstract mechanism.",
      acceptable_adaptation: "Similar shot cadence and theme, but completely distinct actors, audio, and branding.",
      borderline_copy: "Nearly identical shot framing or dangerously similar dialogue requiring human review.",
      plagiarism_reject: "Direct copy of reference media frames, verbatim speech, or stolen creative assets.",
    },
    evidenceRequirements: ["artifact_perception", "source_reference"],
    policyMapping: {
      rejectionValues: ["borderline_copy", "plagiarism_reject"],
    },
  },
};
