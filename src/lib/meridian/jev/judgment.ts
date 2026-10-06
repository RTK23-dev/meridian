import { clamp01 } from "../domain.ts";
import {
  decide,
  type AnswerValue,
  type CalibrationStep,
  type DecisionState,
  type EvidenceRef,
  type EvidenceState,
  type ProbabilisticAnswer,
  type ThresholdConfig,
} from "./engine.ts";

/** A versioned linear model. It scores features. It does not choose a decision. */
export type JudgmentModel = {
  id: string;
  version: string;
  bias: number;
  weights: Record<string, number>;
};

export type Feature = {
  name: string;
  value: number;
  evidenceId: string;
  source: string;
  summary: string;
};

export const PRIOR_JUDGMENT: JudgmentModel = {
  id: "logistic-prior",
  version: "v1",
  bias: -0.35,
  weights: {
    aligned: 1.5,
    coverage: 1.1,
    history: 0.8,
    violation: -3.1,
    mismatch: -2.6,
    missing: -0.2,
  },
};

export const REVIEW_POLICY: ThresholdConfig = {
  autoApprove: 0.82,
  humanReview: 0.45,
  minConfidenceForAuto: 0.7,
};

export type QuestionSpec = {
  id: string;
  version: string;
  description: string;
  featureNames: string[];
  evidenceRequirements: string[];
  evaluator: string;
  calibration: "prior" | "fitted";
  policyId: string;
  thresholds: ThresholdConfig;
};

export const QUESTION_SPECS: QuestionSpec[] = [
  ["brand_fit", "Whether the candidate uses this brand's positioning."],
  ["competitive_strength", "Whether the candidate is crowded or open in stored observations."],
  ["positioning_fit", "Whether the promise matches the stored positioning."],
  ["opportunity_quality", "Whether the evidence is enough to pursue the candidate."],
  ["brief_completeness", "Whether the brief has an audience, product, hook, and format."],
  ["claim_safety", "Whether the copy stays inside allowed claims."],
  ["brand_safety", "Whether the copy avoids stored brand-risk language."],
  ["duplicate_risk", "Whether this creative repeats one this brand already ran."],
  ["competitor_copy_risk", "Whether the copy repeats a competitor's wording."],
  ["logo_match", "Whether the logo evidence matches the stored mark."],
  ["palette_match", "Whether the palette evidence matches the brand."],
  ["product_match", "Whether the product in the asset is the briefed product."],
  ["tone_fit", "Whether the tone evidence matches the brand voice."],
  ["novelty", "Whether this brand has already used the direction."],
  ["market_saturation", "Whether stored competitors already cover the direction."],
  ["reproducibility", "Whether a workflow can make the variant without copied phrasing."],
  ["creative_quality", "Whether the variant has the structured fields a review needs."],
  ["image_readiness", "Whether an image asset and its metadata exist."],
  ["video_readiness", "Whether a completed video has scene or transcript evidence."],
  ["publishing_readiness", "Whether the creative can be sent to a publisher."],
].map(([id, description]) => ({
  id,
  version: "v1",
  description,
  featureNames: Object.keys(PRIOR_JUDGMENT.weights),
  evidenceRequirements: ["At least one structured feature, or an explicit missing-evidence flag."],
  evaluator: "logistic-v1",
  calibration: "prior" as const,
  policyId: "review-policy-v1",
  thresholds: { ...REVIEW_POLICY },
}));

export type AuditedDecision = {
  questionId: string;
  questionVersion: string;
  modelVersion: string;
  features: { name: string; value: number }[];
  probability: number;
  rawProbability: number;
  confidence: number;
  decision: DecisionState;
  reasons: string[];
  evidence: EvidenceRef[];
  policy: ThresholdConfig;
  answer: ProbabilisticAnswer;
  policyVersion: string;
  calibrationVersion: string | null;
  provider: string;
  schemaVersion: string;
  decidedAt: string;
  evidenceState: EvidenceState;
};

export type JudgeOptions = {
  thresholds?: ThresholdConfig;
  policyVersion?: string;
  calibration?: CalibrationStep | null;
  provider?: string;
  now?: string;
};

export function sigmoid(value: number): number {
  if (value > 20) return 1;
  if (value < -20) return 0;
  return 1 / (1 + Math.exp(-value));
}

/** Evidence present is a policy input. The model does not name the decision. */
export function judgeFeatures(
  spec: QuestionSpec,
  features: Feature[],
  model: JudgmentModel,
  evidencePresent: boolean,
  options?: JudgeOptions,
): AuditedDecision {
  let score = model.bias;
  for (const feature of features) {
    const weight = model.weights[feature.name];
    if (weight == null) continue;
    score += weight * clamp01(feature.value);
  }
  let probability = sigmoid(score);
  let confidence = features.length === 0 ? 0.25 : Math.min(0.93, 0.45 + features.length * 0.08);
  const violation = features.some((feature) => feature.name === "violation" && feature.value >= 0.99);
  const contradictory =
    !violation &&
    features.some((feature) => feature.name === "aligned" && feature.value >= 0.8) &&
    features.some((feature) => feature.name === "violation" && feature.value >= 0.5);
  const evidenceState: EvidenceState = !evidencePresent ? "missing" : violation ? "violation" : contradictory ? "contradictory" : "present";
  if (!evidencePresent) {
    probability = Math.min(spec.thresholds.autoApprove - 0.05, Math.max(spec.thresholds.humanReview, probability));
    confidence = Math.min(confidence, spec.thresholds.minConfidenceForAuto - 0.05);
  }
  const evaluation = {
    probability,
    confidence,
    reasons: features.map((feature) => feature.summary).slice(0, 6),
    evidence: features.map((feature) => ({ id: feature.evidenceId, source: feature.source, summary: feature.summary })),
    evidenceState,
    answer: (violation ? "violation" : undefined) as AnswerValue | undefined,
  };
  if (!evidencePresent) {
    evaluation.reasons.unshift("Evidence is missing. The policy keeps this in review.");
    evaluation.evidence.unshift({
      id: "missing",
      source: spec.id,
      summary: "A required feature was not observed. Approval is not available.",
    });
  }
  const thresholds = options?.thresholds ?? spec.thresholds;
  const decision = decide(
    {
      id: spec.id,
      version: spec.version,
      description: spec.description,
      thresholds,
      evaluate: () => evaluation,
    },
    null,
    {
      calibration: options?.calibration ?? null,
      policyVersion: options?.policyVersion,
      model: model.version,
      provider: options?.provider ?? model.id,
      now: options?.now,
    },
  );
  return {
    questionId: spec.id,
    questionVersion: spec.version,
    modelVersion: model.version,
    features: features.map((feature) => ({ name: feature.name, value: round3(clamp01(feature.value)) })),
    probability: decision.probability,
    rawProbability: decision.rawProbability,
    confidence: decision.confidence,
    decision: decision.decision,
    reasons: decision.reasons,
    evidence: decision.evidence,
    policy: { ...thresholds },
    answer: decision.answer,
    policyVersion: decision.policyVersion,
    calibrationVersion: decision.calibrationVersion,
    provider: decision.provider,
    schemaVersion: decision.schemaVersion,
    decidedAt: decision.decidedAt,
    evidenceState: decision.evidenceState,
  };
}

export type CalibrationRow = {
  features: { name: string; value: number }[];
  approved: boolean;
};

/**
 * One pass of logistic gradient on reviewer outcomes.
 * The returned model is a proposal. It does not replace thresholds.
 */
export function fitReviewerCalibration(
  model: JudgmentModel,
  rows: CalibrationRow[],
  minRows = 30,
): { status: "insufficient" | "fitted"; model: JudgmentModel; meanDisagreement: number } {
  if (rows.length < minRows) {
    return { status: "insufficient", model, meanDisagreement: 0 };
  }
  const next: JudgmentModel = {
    id: model.id,
    version: `${model.version}+reviewers`,
    bias: model.bias,
    weights: { ...model.weights },
  };
  const rate = 0.15;
  let disagreement = 0;
  for (const row of rows) {
    let score = next.bias;
    for (const feature of row.features) {
      score += (next.weights[feature.name] ?? 0) * feature.value;
    }
    const predicted = sigmoid(score);
    const actual = row.approved ? 1 : 0;
    disagreement += Math.abs(predicted - actual);
    const error = predicted - actual;
    next.bias -= rate * error;
    for (const feature of row.features) {
      const current = next.weights[feature.name] ?? 0;
      next.weights[feature.name] = current - rate * error * feature.value;
    }
  }
  return { status: "fitted", model: next, meanDisagreement: disagreement / rows.length };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
