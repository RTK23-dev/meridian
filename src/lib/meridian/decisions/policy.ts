/**
 * Shared decision policy: turns normalized answers into AUTO_APPROVE, HUMAN_REVIEW, or REJECT.
 *
 * Providers never reach this file. Only normalized `JevAnswer` values do, so the policy is the same whichever engine
 * produced them. A policy is versioned and is supplied per question by the caller, so thresholds can change without
 * touching a provider.
 *
 * Fail-closed rules (docs/ARCHITECTURE_CONTRACTS.md, section 6):
 * - A question with no policy mapping produces HUMAN_REVIEW, whatever its answer.
 * - A refused, unsupported, malformed, unavailable, or missing answer takes the policy's unresolved outcome.
 * - A probability can approve only when the policy names an approveMinProbability. A score can approve only when the policy
 *   names an approveMinScore. A choice can approve only when the policy names approveValues. Without them, the answer goes
 *   to review.
 * - A probability or a score is a number the engine reported, not a calibrated risk. Unless its answer is calibrated, it can
 *   route to review and nothing else: it never produces AUTO_APPROVE or REJECT. Confidence is never read as a probability.
 * - A categorical answer is an answer, not a probability. Its explicit approveValues and rejectionValues decide it.
 */
import type { JevAnswer, JevQuestionSpec } from "../jev/types.ts";

export const DECISION_POLICY_VERSION = "decision-policy.v2";

export type PolicyOutcome = "AUTO_APPROVE" | "HUMAN_REVIEW" | "REJECT";

export type CalibrationStatus = "uncalibrated" | "calibrated" | "not_applicable";

export type DecisionPolicy = {
  /** Policy version recorded with every evaluation. Changing thresholds means a new version. */
  version: string;
  /**
   * How a predicate's probability is read. "pass_if_true": the condition must hold (e.g. "the required product is
   * visible"). "reject_if_true": the condition is a defect (e.g. "contains a prohibited claim").
   */
  predicateDirection: "pass_if_true" | "reject_if_true";
  /** Required before a probability can approve. Absent, a probability goes to review and never approves. */
  approveMinProbability?: number;
  reviewMinProbability: number;
  /** Choice values that approve. Absent, a choice cannot approve. A choice in neither list goes to review. */
  approveChoices?: string[];
  /** Choice values that reject. */
  rejectChoices?: string[];
  /** Required before a score can approve. Absent, a score goes to review. */
  approveMinScore?: number;
  /** Outcome when a required answer is refused, unsupported, malformed, unavailable, or missing. */
  unresolvedOutcome: "HUMAN_REVIEW" | "REJECT";
  /** An answer whose provider confidence is below this goes to human review. Never approves on low confidence. */
  minConfidence?: number;
};

export type PolicyVote = {
  questionId: string;
  outcome: PolicyOutcome;
  reason: string;
  calibrationStatus: CalibrationStatus;
};

export type PolicyUnresolved = {
  questionId: string;
  status: JevAnswer["status"] | "missing" | "no_policy";
  reason: string;
};

export type PolicyEvaluation = {
  outcome: PolicyOutcome;
  policyVersion: string;
  votes: PolicyVote[];
  unresolved: PolicyUnresolved[];
  /** Probability and score votes that are not calibrated. Categorical votes are not counted. */
  uncalibratedAnswers: number;
};

/** One question as the evaluator sees it. A null policy means the question has no policy mapping. */
export type PolicyQuestion = {
  questionId: string;
  policy: DecisionPolicy | null;
  /** False when the question's evidence scope held no evidence, so its answer cannot approve. Absent means present. */
  scopePresent?: boolean;
};

const RANK: Record<PolicyOutcome, number> = { AUTO_APPROVE: 0, HUMAN_REVIEW: 1, REJECT: 2 };

type AnswerKind = "predicate" | "categorical" | "score" | "none";

function answerKindOf(answer: JevAnswer): AnswerKind {
  if (answer.semantics === "probability" || typeof answer.probability === "number") return "predicate";
  if (answer.semantics === "categorical" || typeof answer.choice === "string") return "categorical";
  if (typeof answer.score === "number") return "score";
  return "none";
}

/** Whether an answer's value is calibrated. Categorical answers are not probabilities, so calibration does not apply to them. */
export function calibrationStatusOf(answer: JevAnswer): CalibrationStatus {
  const kind = answerKindOf(answer);
  if (kind === "categorical" || kind === "none") return "not_applicable";
  return answer.calibrationStatus === "calibrated" ? "calibrated" : "uncalibrated";
}

function voteFor(answer: JevAnswer, policy: DecisionPolicy): PolicyVote | null {
  if (answer.status !== "answered") return null;
  const calibrationStatus = calibrationStatusOf(answer);
  if (policy.minConfidence !== undefined && typeof answer.confidence === "number" && answer.confidence < policy.minConfidence) {
    return {
      questionId: answer.questionId,
      outcome: "HUMAN_REVIEW",
      reason: `Confidence ${answer.confidence} is below the policy minimum ${policy.minConfidence}.`,
      calibrationStatus,
    };
  }
  const kind = answerKindOf(answer);
  if (kind === "predicate") return predicateVote(answer, policy, calibrationStatus);
  if (kind === "categorical") return choiceVote(answer, policy);
  if (kind === "score" && typeof answer.score === "number") return scoreVote(answer.questionId, answer.score, policy, calibrationStatus);
  return null;
}

function predicateVote(answer: JevAnswer, policy: DecisionPolicy, calibrationStatus: CalibrationStatus): PolicyVote | null {
  const probability = answer.probability ?? answer.noul;
  if (typeof probability !== "number") return null;
  const questionId = answer.questionId;
  if (policy.approveMinProbability === undefined) {
    return {
      questionId,
      outcome: "HUMAN_REVIEW",
      reason: `Probability ${probability.toFixed(3)} has no approveMinProbability in ${policy.version}, so it cannot approve.`,
      calibrationStatus,
    };
  }
  const passFirst = policy.predicateDirection === "pass_if_true";
  const approveAt = passFirst ? policy.approveMinProbability : 1 - policy.approveMinProbability;
  const reviewAt = passFirst ? policy.reviewMinProbability : 1 - policy.reviewMinProbability;
  const passes = passFirst ? probability >= approveAt : probability <= approveAt;
  const reviewable = passFirst ? probability >= reviewAt : probability <= reviewAt;
  const raw: PolicyOutcome = passes ? "AUTO_APPROVE" : reviewable ? "HUMAN_REVIEW" : "REJECT";
  const reading = `Probability ${probability.toFixed(3)} against ${policy.predicateDirection} thresholds ${approveAt.toFixed(2)}/${reviewAt.toFixed(2)}.`;
  if (raw !== "HUMAN_REVIEW" && calibrationStatus !== "calibrated") {
    return { questionId, outcome: "HUMAN_REVIEW", reason: `${reading} It is uncalibrated, so it can only go to review.`, calibrationStatus };
  }
  return { questionId, outcome: raw, reason: reading, calibrationStatus };
}

function choiceVote(answer: JevAnswer, policy: DecisionPolicy): PolicyVote {
  const choice = answer.choice ?? String(answer.answer);
  const questionId = answer.questionId;
  const calibrationStatus: CalibrationStatus = "not_applicable";
  if (policy.rejectChoices?.includes(choice)) {
    return { questionId, outcome: "REJECT", reason: `Choice '${choice}' is a rejection value.`, calibrationStatus };
  }
  if (policy.approveChoices?.includes(choice)) {
    return { questionId, outcome: "AUTO_APPROVE", reason: `Choice '${choice}' is an approval value.`, calibrationStatus };
  }
  const reason = policy.approveChoices === undefined
    ? `Choice '${choice}' cannot approve: the policy names no approve values.`
    : `Choice '${choice}' has no approval rule.`;
  return { questionId, outcome: "HUMAN_REVIEW", reason, calibrationStatus };
}

function scoreVote(questionId: string, score: number, policy: DecisionPolicy, calibrationStatus: CalibrationStatus): PolicyVote {
  if (policy.approveMinScore === undefined) {
    return { questionId, outcome: "HUMAN_REVIEW", reason: "Score has no approval threshold.", calibrationStatus };
  }
  const reading = `Score ${score.toFixed(2)} against minimum ${policy.approveMinScore}.`;
  if (score < policy.approveMinScore) return { questionId, outcome: "HUMAN_REVIEW", reason: reading, calibrationStatus };
  if (calibrationStatus !== "calibrated") {
    return { questionId, outcome: "HUMAN_REVIEW", reason: `${reading} It is uncalibrated, so it can only go to review.`, calibrationStatus };
  }
  return { questionId, outcome: "AUTO_APPROVE", reason: reading, calibrationStatus };
}

/** Evaluates every expected question under one policy. `expectedQuestionIds` lets a missing answer count as unresolved. */
export function evaluateDecisionPolicy(
  answers: Record<string, JevAnswer>,
  policy: DecisionPolicy,
  expectedQuestionIds: string[] = Object.values(answers).map((answer) => answer.questionId),
): PolicyEvaluation {
  const votes: PolicyVote[] = [];
  const unresolved: PolicyUnresolved[] = [];
  const byQuestion = new Map<string, JevAnswer>();
  for (const answer of Object.values(answers)) byQuestion.set(answer.questionId, answer);

  for (const questionId of expectedQuestionIds) {
    const answer = byQuestion.get(questionId);
    if (!answer) {
      unresolved.push({ questionId, status: "missing", reason: "No answer was returned for this question." });
      continue;
    }
    const vote = voteFor(answer, policy);
    if (vote) {
      votes.push(vote);
      continue;
    }
    // Refused, unsupported, malformed, unavailable, or abstained: never a vote for approval.
    unresolved.push({
      questionId,
      status: answer.status,
      reason: answer.abstainReason ?? `Answer status '${answer.status}' is not an answer.`,
    });
  }

  let outcome: PolicyOutcome = "AUTO_APPROVE";
  if (votes.length === 0 && unresolved.length === 0) outcome = "HUMAN_REVIEW";
  for (const vote of votes) {
    if (RANK[vote.outcome] > RANK[outcome]) outcome = vote.outcome;
  }
  if (unresolved.length > 0) {
    const unresolvedRank = RANK[policy.unresolvedOutcome];
    if (unresolvedRank > RANK[outcome]) outcome = policy.unresolvedOutcome;
  }

  return {
    outcome,
    policyVersion: policy.version,
    votes,
    unresolved,
    uncalibratedAnswers: votes.filter((vote) => vote.calibrationStatus === "uncalibrated").length,
  };
}

/** Policies for the decision types Meridian uses. Thresholds are versioned and are not provider settings. */
export const SAFETY_GATE_POLICY: DecisionPolicy = {
  version: "safety-gate.v1",
  predicateDirection: "reject_if_true",
  approveMinProbability: 0.9,
  reviewMinProbability: 0.6,
  rejectChoices: ["unsafe", "prohibited"],
  approveChoices: ["safe"],
  unresolvedOutcome: "REJECT",
};

export const CREATIVE_QA_POLICY: DecisionPolicy = {
  version: "creative-qa.v1",
  predicateDirection: "pass_if_true",
  approveMinProbability: 0.85,
  reviewMinProbability: 0.6,
  unresolvedOutcome: "HUMAN_REVIEW",
};

/**
 * Evaluates each question with its own policy, so a registry question keeps its own thresholds and unresolved outcome.
 * A question with no answer is unresolved under its policy. A question with no policy goes to review. The most severe
 * outcome across questions wins. AUTO_APPROVE needs every question to have a policy, evidence in scope, and an approval.
 */
export function evaluateQuestionPolicies(answers: Record<string, JevAnswer>, questions: PolicyQuestion[]): PolicyEvaluation {
  const votes: PolicyVote[] = [];
  const unresolved: PolicyUnresolved[] = [];
  const byQuestion = new Map<string, JevAnswer>();
  for (const answer of Object.values(answers)) byQuestion.set(answer.questionId, answer);

  let outcome: PolicyOutcome = questions.length === 0 ? "HUMAN_REVIEW" : "AUTO_APPROVE";
  const raise = (candidate: PolicyOutcome) => {
    if (RANK[candidate] > RANK[outcome]) outcome = candidate;
  };

  for (const { questionId, policy, scopePresent } of questions) {
    if (!policy) {
      unresolved.push({ questionId, status: "no_policy", reason: "No policy is mapped for this question, so its answer cannot approve it." });
      raise("HUMAN_REVIEW");
      continue;
    }
    const answer = byQuestion.get(questionId);
    if (!answer) {
      unresolved.push({ questionId, status: "missing", reason: "No answer was returned for this question." });
      raise(policy.unresolvedOutcome);
      continue;
    }
    if (answer.status !== "answered") {
      const status = answer.status;
      unresolved.push({ questionId, status, reason: answer.abstainReason ?? `Answer status '${status}' is not an answer.` });
      raise(policy.unresolvedOutcome);
      continue;
    }
    if (scopePresent === false) {
      unresolved.push({ questionId, status: "abstain_insufficient_evidence", reason: "No evidence was in this question's scope, so its answer cannot approve it." });
      raise(policy.unresolvedOutcome);
      continue;
    }
    const vote = voteFor(answer, policy);
    if (vote) {
      votes.push(vote);
      raise(vote.outcome);
      continue;
    }
    unresolved.push({ questionId, status: answer.status, reason: answer.abstainReason ?? "The answer has no usable value." });
    raise(policy.unresolvedOutcome);
  }

  return {
    outcome,
    policyVersion: questions.map((entry) => entry.policy?.version ?? `${entry.questionId}(no-policy)`).join(","),
    votes,
    unresolved,
    uncalibratedAnswers: votes.filter((vote) => vote.calibrationStatus === "uncalibrated").length,
  };
}

/**
 * The policy for one registry question. Thresholds and values come from the question's policyMapping, so they are versioned
 * with the question. A question with no mapping has no policy: it returns null, and the evaluator sends it to review.
 */
export function policyForQuestion(spec: Pick<JevQuestionSpec, "id" | "version" | "policyMapping">): DecisionPolicy | null {
  const mapping = spec.policyMapping;
  if (!mapping) return null;
  return {
    version: `${spec.id}@${spec.version}`,
    predicateDirection: mapping.predicateDirection ?? "pass_if_true",
    // Left undefined when absent. A probability then cannot approve, and the evaluator says why.
    approveMinProbability: mapping.approveMinProbability,
    reviewMinProbability: mapping.reviewMinProbability ?? 0,
    approveChoices: mapping.approveValues,
    rejectChoices: mapping.rejectionValues,
    approveMinScore: mapping.approveMinScore,
    unresolvedOutcome: mapping.unresolvedOutcome ?? "HUMAN_REVIEW",
    minConfidence: mapping.minConfidence,
  };
}

/** The version a question is recorded under. A question with no mapping is recorded as such, so a reviewer can see it. */
export function policyVersionOf(spec: Pick<JevQuestionSpec, "id" | "version" | "policyMapping">): string {
  return spec.policyMapping ? `${spec.id}@${spec.version}` : `${spec.id}@${spec.version}(no-policy)`;
}
