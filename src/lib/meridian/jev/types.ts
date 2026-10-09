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

export type JevAnswerStatus =
  | "answered"
  | "abstain_insufficient_evidence"
  | "abstain_uncertain"
  | "provider_error"
  | "not_configured";

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
};

export type AbstainedJevAnswer = {
  questionId: string;
  questionVersion: string;
  type?: JevQuestionType;
  model: string;
  provider: string;
  status: "abstain_insufficient_evidence" | "abstain_uncertain" | "provider_error" | "not_configured";
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

