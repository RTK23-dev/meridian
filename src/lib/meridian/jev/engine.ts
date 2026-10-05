import { clamp01 } from "../domain.ts";

export const DECISIONS = ["AUTO_APPROVE", "HUMAN_REVIEW", "REJECT"] as const;
export type DecisionState = (typeof DECISIONS)[number];

export type ThresholdConfig = {
  /** Probability at or above this can auto-approve, if confidence is also high enough. */
  autoApprove: number;
  /** Probability at or above this, but below auto-approve, waits for a person. */
  humanReview: number;
  /** Below this confidence, auto-approve is downgraded to human review. */
  minConfidenceForAuto: number;
};

export type EvidenceRef = {
  id: string;
  source: string;
  summary: string;
};

export type Evaluation = {
  probability: number;
  confidence: number;
  reasons: string[];
  evidence: EvidenceRef[];
};

export type DecisionQuestion<TInput> = {
  id: string;
  version: string;
  description: string;
  thresholds: ThresholdConfig;
  evaluate: (input: TInput) => Evaluation;
};

export type DecisionOutput = {
  decision: DecisionState;
  probability: number;
  confidence: number;
  reasons: string[];
  evidence: EvidenceRef[];
  questionId: string;
  questionVersion: string;
  thresholds: ThresholdConfig;
};

/**
 * Deterministic gate. The evaluator may be fed by a model, but the model does
 * not choose AUTO_APPROVE / HUMAN_REVIEW / REJECT. Thresholds do.
 */
export function decide<TInput>(question: DecisionQuestion<TInput>, input: TInput): DecisionOutput {
  const evaluation = question.evaluate(input);
  const probability = round3(clamp01(evaluation.probability));
  const confidence = round3(clamp01(evaluation.confidence));
  let decision: DecisionState;
  if (
    probability >= question.thresholds.autoApprove &&
    confidence >= question.thresholds.minConfidenceForAuto
  ) {
    decision = "AUTO_APPROVE";
  } else if (probability >= question.thresholds.humanReview) {
    decision = "HUMAN_REVIEW";
  } else {
    decision = "REJECT";
  }
  return {
    decision,
    probability,
    confidence,
    reasons: evaluation.reasons.length > 0 ? evaluation.reasons : ["No reason was recorded."],
    evidence: evaluation.evidence,
    questionId: question.id,
    questionVersion: question.version,
    thresholds: question.thresholds,
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
