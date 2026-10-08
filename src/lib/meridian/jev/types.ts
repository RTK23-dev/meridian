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
  evidenceRequirements: string[];
  outputInterpretation?: Record<string, string>;
  policyMapping?: {
    approveMinProbability?: number;
    reviewMinProbability?: number;
    rejectionValues?: string[];
  };
};

export type EvidenceRef = {
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
  | "abstain_uncertain";

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

export type JevAnswer = {
  questionId: string;
  questionVersion: string;
  type?: JevQuestionType;
  model: string;
  provider: string;
  status: JevAnswerStatus;
  choice?: string;
  noul?: number;
  score?: number;
  answer?: string | boolean | number;
  probability?: number;
  probabilities?: Record<string, number>;
  distribution?: Record<string, number>;
  confidence?: number;
  legend?: Record<string, string>;
  evidenceRefs: EvidenceRef[];
  abstainReason?: string;
  evaluatedAt: string;
};

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
