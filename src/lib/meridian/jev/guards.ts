import type { DecisionQuestion } from "./engine.ts";

export type DuplicateRiskInput = {
  relation: "new" | "similar" | "derivative" | "duplicate" | "too_close_to_competitor" | "";
};

export const duplicateRisk: DecisionQuestion<DuplicateRiskInput> = {
  id: "duplicate_risk",
  version: "v1",
  description: "Whether a creative is too close to one already stored.",
  thresholds: { autoApprove: 0.9, humanReview: 0.45, minConfidenceForAuto: 0.8 },
  evaluate(input) {
    if (input.relation === "too_close_to_competitor" || input.relation === "duplicate") {
      return {
        probability: 0.05,
        confidence: 0.9,
        reasons: ["Stored similarity is too close to publish as new."],
        evidence: [{ id: input.relation, source: "similarity", summary: input.relation }],
      };
    }
    if (input.relation === "derivative" || input.relation === "similar") {
      return {
        probability: 0.55,
        confidence: 0.7,
        reasons: ["Similar to a stored creative. A person should look."],
        evidence: [{ id: input.relation, source: "similarity", summary: input.relation }],
      };
    }
    return {
      probability: 0.92,
      confidence: 0.6,
      reasons: [input.relation ? "No close stored neighbor." : "Similarity was not computed."],
      evidence: [],
    };
  },
};

export type PromptSafetyInput = { hostileLines: number };

export const promptSafety: DecisionQuestion<PromptSafetyInput> = {
  id: "prompt_safety",
  version: "v1",
  description: "Whether untrusted source text tried to override instructions.",
  thresholds: { autoApprove: 0.95, humanReview: 0.4, minConfidenceForAuto: 0.8 },
  evaluate(input) {
    if (input.hostileLines > 0) {
      return {
        probability: 0.2,
        confidence: 0.85,
        reasons: ["Instruction-like lines were removed from source text. Do not treat the source as instructions."],
        evidence: [{ id: "injection", source: "ingestion", summary: `${input.hostileLines} lines dropped` }],
      };
    }
    return {
      probability: 0.96,
      confidence: 0.5,
      reasons: ["No instruction-like lines were detected. This is not a proof of safety."],
      evidence: [],
    };
  },
};

export type PublishingReadinessInput = {
  providerConnected: boolean;
  creativeApproved: boolean;
  policyAllowsAutoPublish: boolean;
};

/** Publishing cannot auto-approve. A disconnected provider is a reject, not a fake publish. */
export const publishingReadiness: DecisionQuestion<PublishingReadinessInput> = {
  id: "publishing_readiness",
  version: "v1",
  description: "Whether a creative may be sent to a platform.",
  thresholds: { autoApprove: 1.1, humanReview: 0.5, minConfidenceForAuto: 0.99 },
  evaluate(input) {
    if (!input.providerConnected) {
      return {
        probability: 0.05,
        confidence: 0.99,
        reasons: ["No publishing provider is connected."],
        evidence: [{ id: "publishing", source: "provider", summary: "NOT_CONNECTED" }],
      };
    }
    if (!input.creativeApproved || !input.policyAllowsAutoPublish) {
      return {
        probability: 0.6,
        confidence: 0.8,
        reasons: ["A person still has to approve publishing."],
        evidence: [],
      };
    }
    return {
      probability: 0.7,
      confidence: 0.8,
      reasons: ["Policy would allow a provider call, but this gate does not auto-approve publishing."],
      evidence: [],
    };
  },
};
