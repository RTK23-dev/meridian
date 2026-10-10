/**
 * TypeSafe JEV Types & Contracts
 *
 * Defines the structured decision types for JEV (intelligence + structured judgment layer)
 * using TypeSafe's System One decision primitives:
 * - noul: yes/no probability
 * - choice: selection from predefined choices with probability distribution
 * - score: ordered rubric evaluation
 */

export type JevQuestionType = "noul" | "choice" | "score";

export type JevNoulCriteria = {
  true: string;
  false: string;
};

export type JevChoiceCriteria = Record<string, string>;

export type JevScoreCriteria = string[];

export type JevQuestionCriteria = JevNoulCriteria | JevChoiceCriteria | JevScoreCriteria;

export type JevQuestionSpec = {
  id: string;
  version: string;
  type: JevQuestionType;
  instructions: string;
  criteria: JevQuestionCriteria;
  levels?: Record<string, string>;
  options?: string[];
  evidenceRequirements: string[];
  outputInterpretation?: Record<string, string>;
  policyMapping?: {
    approveMinProbability?: number;
    reviewMinProbability?: number;
    rejectionValues?: string[];
    /** Choice values that approve. A choice in neither list goes to review. */
    approveValues?: string[];
    /** Minimum score index that approves. Without it, a score always goes to human review. */
    approveMinScore?: number;
    /** "reject_if_true" when the predicate describes a defect. Default "pass_if_true". */
    predicateDirection?: "pass_if_true" | "reject_if_true";
    /** Outcome when the answer is refused, unsupported, malformed, or missing. Default HUMAN_REVIEW. */
    unresolvedOutcome?: "HUMAN_REVIEW" | "REJECT";
    /** An answer below this confidence goes to human review. */
    minConfidence?: number;
  };
};

export type EvidenceRef = {
  kind?: string;
  artifactId?: string;
  sourceId?: string;
  field?:
    | "metadata"
    | "profile"
    | "performance"
    | "transcript"
    | "scene"
    | "ocr"
    | "audio"
    | "comment";
  location?: {
    startMs?: number;
    endMs?: number;
    frameId?: string;
  };
  path?: string;
  summary?: string;
};

/**
 * Answer states shared by every decision engine. Only "answered" carries a value. A refusal, an unsupported question or
 * input, and a malformed provider response are their own states, so none of them can be read as an answer.
 */
export type JevAnswerStatus =
  | "answered"
  | "abstain_insufficient_evidence"
  | "abstain_uncertain"
  | "provider_error"
  | "not_configured"
  | "refused"
  | "unsupported"
  | "invalid_response";

export type AbstainedJevStatus = Exclude<JevAnswerStatus, "answered">;

/**
 * What an answered value means. A predicate probability is a probability; a choice is categorical with the provider's
 * confidence; a score is an ordered level (possibly a weighted average between levels). None is calibrated against
 * Meridian outcomes until a calibration report says so.
 */
export type AnswerSemantics = "probability" | "categorical" | "ordered_score";
export type AnswerCalibrationStatus = "uncalibrated" | "calibrated";

export type RawJevAnswer =
  | {
      type: "choice";
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | {
      type: "noul";
      noul: number;
    }
  | {
      type: "score";
      score: number;
      probabilities: Record<string, number>;
      confidence: number;
      legend?: Record<string, string>;
    };

export type AnsweredJevAnswer = {
  questionId: string;
  questionVersion: string;
  type?: JevQuestionType;
  model: string;
  provider: string;
  status: "answered";
  choice?: string;
  noul?: number;
  noulProbability?: number;
  score?: number;
  answer: string | boolean | number;
  probability?: number;
  policyDecision?: string | boolean;
  probabilities?: Record<string, number>;
  distribution?: Record<string, number>;
  confidence?: number;
  legend?: Record<string, string>;
  evidenceRefs: EvidenceRef[];
  abstainReason?: undefined;
  evaluatedAt: string;
  semantics?: AnswerSemantics;
  calibrationStatus?: AnswerCalibrationStatus;
};

export type AbstainedJevAnswer = {
  questionId: string;
  questionVersion: string;
  type?: JevQuestionType;
  model: string;
  provider: string;
  status: AbstainedJevStatus;
  choice?: undefined;
  noul?: undefined;
  score?: undefined;
  answer?: undefined;
  probability?: undefined;
  probabilities?: undefined;
  distribution?: undefined;
  confidence?: undefined;
  legend?: undefined;
  evidenceRefs: EvidenceRef[];
  abstainReason: string;
  evaluatedAt: string;
  semantics?: undefined;
  calibrationStatus?: undefined;
};

export type JevAnswer = AnsweredJevAnswer | AbstainedJevAnswer;

export type MeridianJevAnswer = JevAnswer;

export type JevDecisionRequest = {
  model?: string;
  provider?: string;
  organizationId: string;
  brandId: string;
  state: {
    description: string;
    records?: Array<{
      id: string;
      record: string;
      availableEvidence?: string[];
    }>;
    [key: string]: unknown;
  };
  questions: Record<string, JevQuestionSpec>;
};

export type JevDecisionResponse = {
  runId: string;
  model: string;
  provider: string;
  inputHash: string;
  cached: boolean;
  latencyMs: number;
  answers: Record<string, JevAnswer>;
  requestedProvider?: string;
  requestedModel?: string;
  fallbackUsed?: boolean;
  fallbackFrom?: string;
  fallbackReason?: string;
  comparison?: {
    comparedWith: string;
    agreementRate: number;
    disagreements: Record<string, { primary: unknown; compared: unknown }>;
    comparedResponse: JevDecisionResponse;
  };
};

export type JevPolicyThresholds = {
  autoApprove: number;
  humanReview: number;
  minConfidenceForAuto: number;
};

export type JevDecisionOutcome = "AUTO_APPROVE" | "HUMAN_REVIEW" | "REJECT";

export type JevPolicyEvaluation = {
  decision: JevDecisionOutcome;
  reason: string;
  policyVersion: string;
  thresholds: JevPolicyThresholds;
  supportingCount: number;
  violationCount: number;
  uncertainCount: number;
  evidenceRefs: EvidenceRef[];
};

export interface JevClient {
  decide(request: JevDecisionRequest): Promise<JevDecisionResponse>;
}

export type JevProviderId = "typesafe_direct" | "openrouter";

export type JevCapabilities = {
  primitives: JevQuestionType[];
  batchDecisions: boolean;
  explanation: boolean;
};

export type JevProviderHealth =
  | { status: "READY"; message?: string }
  | { status: "NOT_CONFIGURED"; message: string }
  | { status: "DEGRADED" | "UNAVAILABLE"; message: string };

export interface JevProvider {
  readonly id: JevProviderId;
  capabilities(): JevCapabilities;
  health(): Promise<JevProviderHealth>;
  decide(request: JevDecisionRequest): Promise<JevDecisionResponse>;
}

export type JevRoutingMode = "auto" | "typesafe_direct" | "openrouter" | "compare";

export interface JevRoutingPolicy {
  mode?: JevRoutingMode;
  preferredProvider?: JevProviderId;
  fallbackEnabled?: boolean;
  compareMode?: boolean;
}

export interface JevProviderRouter {
  decide(request: JevDecisionRequest, policy?: JevRoutingPolicy): Promise<JevDecisionResponse>;
  getProvider(id: JevProviderId): JevProvider;
  health(id?: JevProviderId): Promise<Record<JevProviderId, JevProviderHealth>>;
}

