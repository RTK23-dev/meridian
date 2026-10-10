/**
 * Shared decision policy: turns normalized answers into AUTO_APPROVE, HUMAN_REVIEW, or REJECT.
 *
 * Providers never reach this file. Only normalized `JevAnswer` values do, so the policy is the same whichever engine
 * produced them. A policy is versioned and is supplied per question by the caller, so thresholds can change without
 * touching a provider.
 *
 * Fail-closed rules:
 * - A refusal, an unsupported question, a malformed response, a provider error, or a missing required answer is never
 *   an approval. Each is resolved by the policy's `unresolvedOutcome`: HUMAN_REVIEW by default, REJECT for
 *   safety-critical gates.
 * - A predicate probability is compared with thresholds only as a number. Every answer carries its calibration status
 *   into the evaluation, so an uncalibrated probability is visible, not presented as a calibrated risk.
 */
import type { JevAnswer } from "../jev/types.ts";

export const DECISION_POLICY_VERSION = "decision-policy.v1";

export type PolicyOutcome = "AUTO_APPROVE" | "HUMAN_REVIEW" | "REJECT";

export type DecisionPolicy = {
  /** Policy version recorded with every evaluation. Changing thresholds means a new version. */
  version: string;
  /**
   * How a predicate's probability is read. "pass_if_true": the condition must hold (e.g. "the required product is
   * visible"). "reject_if_true": the condition is a defect (e.g. "contains a prohibited claim").
   */
  predicateDirection: "pass_if_true" | "reject_if_true";
  approveMinProbability: number;
  reviewMinProbability: number;
  /** Choice values that approve. A choice in neither list goes to review. */
  approveChoices?: string[];
  /** Choice values that reject. */
  rejectChoices?: string[];
  /** Minimum score index that approves. Without it, a score always goes to review. */
  approveMinScore?: number;
  /** Outcome when a required answer is refused, unsupported, malformed, unavailable, or missing. */
  unresolvedOutcome: "HUMAN_REVIEW" | "REJECT";
};

export type PolicyVote = {
  questionId: string;
  outcome: PolicyOutcome;
  reason: string;
  calibrationStatus: "uncalibrated" | "calibrated" | "not_applicable";
};

export type PolicyEvaluation = {
  outcome: PolicyOutcome;
  policyVersion: string;
  votes: PolicyVote[];
  unresolved: Array<{ questionId: string; status: JevAnswer["status"] | "missing"; reason: string }>;
  uncalibratedAnswers: number;
};

const RANK: Record<PolicyOutcome, number> = { AUTO_APPROVE: 0, HUMAN_REVIEW: 1, REJECT: 2 };

function voteFor(answer: JevAnswer, policy: DecisionPolicy): PolicyVote | null {
  if (answer.status !== "answered") return null;
  const calibrationStatus = answer.calibrationStatus ?? "uncalibrated";

  if (answer.semantics === "probability" || typeof answer.probability === "number") {
    const probability = answer.probability ?? answer.noul;
    if (typeof probability !== "number") return null;
    const conditionTrue = probability;
    const approveAt = policy.predicateDirection === "pass_if_true" ? policy.approveMinProbability : 1 - policy.approveMinProbability;
    const reviewAt = policy.predicateDirection === "pass_if_true" ? policy.reviewMinProbability : 1 - policy.reviewMinProbability;
    const passes = policy.predicateDirection === "pass_if_true" ? conditionTrue >= approveAt : conditionTrue <= approveAt;
    const reviewable = policy.predicateDirection === "pass_if_true" ? conditionTrue >= reviewAt : conditionTrue <= reviewAt;
    const outcome: PolicyOutcome = passes ? "AUTO_APPROVE" : reviewable ? "HUMAN_REVIEW" : "REJECT";
    return {
      questionId: answer.questionId,
      outcome,
      reason: `Probability ${probability.toFixed(3)} against ${policy.predicateDirection} thresholds ${approveAt.toFixed(2)}/${reviewAt.toFixed(2)}.`,
      calibrationStatus,
    };
  }

  if (answer.semantics === "categorical" || typeof answer.choice === "string") {
    const choice = answer.choice ?? String(answer.answer);
    if (policy.rejectChoices?.includes(choice)) {
      return { questionId: answer.questionId, outcome: "REJECT", reason: `Choice '${choice}' is a rejection value.`, calibrationStatus };
    }
    if (policy.approveChoices?.includes(choice)) {
      return { questionId: answer.questionId, outcome: "AUTO_APPROVE", reason: `Choice '${choice}' is an approval value.`, calibrationStatus };
    }
    return { questionId: answer.questionId, outcome: "HUMAN_REVIEW", reason: `Choice '${choice}' has no approval rule.`, calibrationStatus };
  }

  if (typeof answer.score === "number") {
    if (policy.approveMinScore === undefined) {
      return { questionId: answer.questionId, outcome: "HUMAN_REVIEW", reason: "Score has no approval threshold.", calibrationStatus };
    }
    const passes = answer.score >= policy.approveMinScore;
    return {
      questionId: answer.questionId,
      outcome: passes ? "AUTO_APPROVE" : "HUMAN_REVIEW",
      reason: `Score ${answer.score.toFixed(2)} against minimum ${policy.approveMinScore}.`,
      calibrationStatus,
    };
  }

  return null;
}

/** Evaluates every expected question. `expectedQuestionIds` lets a missing answer count as unresolved. */
export function evaluateDecisionPolicy(
  answers: Record<string, JevAnswer>,
  policy: DecisionPolicy,
  expectedQuestionIds: string[] = Object.values(answers).map((answer) => answer.questionId),
): PolicyEvaluation {
  const votes: PolicyVote[] = [];
  const unresolved: PolicyEvaluation["unresolved"] = [];
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
    uncalibratedAnswers: votes.filter((vote) => vote.calibrationStatus !== "calibrated").length,
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
