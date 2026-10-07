import { assertSameTenant, clamp01 } from "../domain.ts";

export const DECISIONS = ["AUTO_APPROVE", "HUMAN_REVIEW", "REJECT"] as const;
export type DecisionState = (typeof DECISIONS)[number];

export const ANSWER_SCHEMA_VERSION = "jev.answer.v1";

export type ThresholdConfig = {
  /** Score at or above this can auto-approve, if confidence is also high enough. */
  autoApprove: number;
  /** Score at or above this, but below auto-approve, waits for a person. */
  humanReview: number;
  /** Below this confidence, auto-approve is downgraded to human review. */
  minConfidenceForAuto: number;
};

export type EvidenceRef = {
  id: string;
  source: string;
  summary: string;
};

/** What the evidence supports. Not a decision. */
export type AnswerValue = "yes" | "no" | "uncertain" | "insufficient" | "violation";

export type EvidenceState = "present" | "missing" | "contradictory" | "violation";

export type Evaluation = {
  /** Uncalibrated score in [0, 1]. Not a probability until a calibration report says so. */
  score?: number;
  /** @deprecated Prefer `score`. Kept so existing questions keep compiling. */
  probability: number;
  confidence: number;
  reasons: string[];
  evidence: EvidenceRef[];
  /** Set by the question when evidence is missing, contradictory, or a violation. */
  evidenceState?: EvidenceState;
  answer?: AnswerValue;
};

export type ProbabilisticAnswer = {
  schemaVersion: typeof ANSWER_SCHEMA_VERSION;
  value: AnswerValue;
  /** Uncalibrated score. Same value as `probability` for stored rows. */
  score: number;
  /** @deprecated Prefer `score`. Persisted column name. */
  probability: number;
  confidence: number;
};

/** Applied after the score and before the policy. Null means identity. */
export type CalibrationStep = {
  version: string;
  apply: (score: number) => number;
};

export type DecisionContext = {
  calibration?: CalibrationStep | null;
  model?: string;
  provider?: string;
  now?: string;
  policyVersion?: string;
};

export type DecisionOutput = {
  decision: DecisionState;
  /** Uncalibrated score. Same value as `probability`. */
  score: number;
  rawScore: number;
  /** @deprecated Prefer `score`. Persisted as jev_decisions.probability. */
  probability: number;
  /** @deprecated Prefer `rawScore`. */
  rawProbability: number;
  confidence: number;
  reasons: string[];
  evidence: EvidenceRef[];
  questionId: string;
  questionVersion: string;
  schemaVersion: typeof ANSWER_SCHEMA_VERSION;
  thresholds: ThresholdConfig;
  answer: ProbabilisticAnswer;
  policyVersion: string;
  calibrationVersion: string | null;
  model: string;
  provider: string;
  decidedAt: string;
  evidenceState: EvidenceState;
};

function evaluationScore(evaluation: Evaluation): number {
  if (typeof evaluation.score === "number" && Number.isFinite(evaluation.score)) return evaluation.score;
  return evaluation.probability;
}

/**
 * Evidence → question → score → calibration → policy → decision.
 * The evaluator does not choose AUTO_APPROVE / HUMAN_REVIEW / REJECT.
 * Missing or contradictory evidence cannot auto-approve.
 * A violation cannot auto-approve or stay in review.
 * Calibration, when supplied, changes this result only. It does not rewrite a previous result.
 * The numeric output is a score, not a calibrated probability.
 */
export function decide<TInput>(
  question: DecisionQuestion<TInput>,
  input: TInput,
  context?: DecisionContext,
): DecisionOutput {
  const evaluation = question.evaluate(input);
  const rawScore = round3(clamp01(evaluationScore(evaluation)));
  const calibrated = context?.calibration ? context.calibration.apply(rawScore) : rawScore;
  const score = round3(clamp01(calibrated));
  const confidence = round3(clamp01(evaluation.confidence));
  const evidenceState: EvidenceState =
    evaluation.evidenceState ?? (evaluation.evidence.length === 0 ? "missing" : "present");
  let decision: DecisionState;
  if (evidenceState === "violation" || evaluation.answer === "violation") {
    decision = "REJECT";
  } else if (evidenceState === "missing" || evidenceState === "contradictory") {
    decision = "HUMAN_REVIEW";
  } else if (
    score >= question.thresholds.autoApprove &&
    confidence >= question.thresholds.minConfidenceForAuto
  ) {
    decision = "AUTO_APPROVE";
  } else if (score >= question.thresholds.humanReview) {
    decision = "HUMAN_REVIEW";
  } else {
    decision = "REJECT";
  }
  const answerValue = answerFor(decision, evidenceState, evaluation.answer);
  return {
    decision,
    score,
    rawScore,
    probability: score,
    rawProbability: rawScore,
    confidence,
    reasons: evaluation.reasons.length > 0 ? evaluation.reasons : ["No reason was recorded."],
    evidence: evaluation.evidence,
    questionId: question.id,
    questionVersion: question.version,
    schemaVersion: ANSWER_SCHEMA_VERSION,
    thresholds: question.thresholds,
    answer: {
      schemaVersion: ANSWER_SCHEMA_VERSION,
      value: answerValue,
      score,
      probability: score,
      confidence,
    },
    policyVersion: context?.policyVersion ?? `code:${question.id}.${question.version}`,
    calibrationVersion: context?.calibration?.version ?? null,
    model: context?.model ?? "deterministic",
    provider: context?.provider ?? "jev",
    decidedAt: context?.now ?? new Date().toISOString(),
    evidenceState,
  };
}

export type DecisionQuestion<TInput> = {
  id: string;
  version: string;
  description: string;
  thresholds: ThresholdConfig;
  evaluate: (input: TInput) => Evaluation;
};

/** Refuses another workspace's rows before a question runs. */
export function decideForTenant<TInput>(
  question: DecisionQuestion<TInput>,
  input: TInput,
  tenant: {
    organizationId: string;
    brandId: string;
    evidence: { organizationId: string; brandId: string }[];
  },
  context?: DecisionContext,
): DecisionOutput {
  assertSameTenant(tenant.evidence, tenant.organizationId, tenant.brandId);
  return decide(question, input, context);
}

function answerFor(decision: DecisionState, state: EvidenceState, explicit?: AnswerValue): AnswerValue {
  if (explicit === "violation" || state === "violation") return "violation";
  if (state === "missing" || state === "contradictory") return "insufficient";
  if (explicit) return explicit;
  if (decision === "AUTO_APPROVE") return "yes";
  if (decision === "REJECT") return "no";
  return "uncertain";
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
