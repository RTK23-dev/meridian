/**
 * JEV Deterministic Decision Policy
 *
 * Translates structured JEV answers into business decisions:
 * AUTO_APPROVE | HUMAN_REVIEW | REJECT
 *
 * Rules:
 * - Missing evidence or low confidence CANNOT auto-approve (must route to HUMAN_REVIEW).
 * - Severe policy violation or rights copy risk forces REJECT.
 * - Thresholds are explicit, versioned, and evaluated deterministically.
 */

import type {
  JevAnswer,
  JevPolicyEvaluation,
  JevPolicyThresholds,
  EvidenceRef,
} from "./types.ts";
import { getQuestionById } from "./registry.ts";
import { approvedThresholds } from "../calibration/active.ts";
import type { CalibrationStep, DecisionQuestion, ThresholdConfig } from "./engine.ts";
import type { Sql } from "../learning/store.ts";

export type AppliedPolicy = {
  thresholds: ThresholdConfig;
  policyVersion: string;
  calibration: CalibrationStep | null;
};

type VersionRow = { question_id: string; version: number | string; thresholds: string };

/** Latest approved threshold version for one question. None means the code policy, unchanged. */
export async function loadQuestionPolicy<TInput>(
  sql: Sql,
  organizationId: string,
  question: DecisionQuestion<TInput>,
): Promise<{ question: DecisionQuestion<TInput>; policy: AppliedPolicy }> {
  const versions = await sql<VersionRow>`
    select question_id, version, thresholds from jev_threshold_versions
    where organization_id = ${organizationId} and question_id = ${question.id}
    order by version desc
    limit 1
  `;
  const policy = policyFromRow(question.id, question.version, question.thresholds, versions[0] ?? null);
  return { question: { ...question, thresholds: policy.thresholds }, policy };
}

/** Latest approved policies for this workspace. Questions without a row are absent. */
export async function loadAppliedPolicies(sql: Sql, organizationId: string): Promise<Map<string, AppliedPolicy>> {
  const rows = await sql<VersionRow>`
    select question_id, version, thresholds from jev_threshold_versions
    where organization_id = ${organizationId}
    order by version desc
  `;
  const map = new Map<string, AppliedPolicy>();
  for (const row of rows) {
    if (map.has(row.question_id)) continue;
    map.set(row.question_id, policyFromRow(row.question_id, "v1", { autoApprove: 0.82, humanReview: 0.45, minConfidenceForAuto: 0.7 }, row));
  }
  return map;
}

function policyFromRow(
  questionId: string,
  questionVersion: string,
  fallback: ThresholdConfig,
  row: VersionRow | null,
): AppliedPolicy {
  if (!row) {
    return {
      thresholds: fallback,
      policyVersion: `code:${questionId}.${questionVersion}`,
      calibration: null,
    };
  }
  const thresholds = approvedThresholds(fallback, { thresholds: row.thresholds });
  const offset = probabilityOffset(row.thresholds);
  const version = Number(row.version);
  return {
    thresholds,
    policyVersion: `approved:${questionId}.${version}`,
    calibration: {
      version: `threshold-version:${version}`,
      apply: (probability) => probability + offset,
    },
  };
}

function probabilityOffset(raw: string): number {
  try {
    const parsed = JSON.parse(raw) as { probabilityOffset?: unknown };
    if (typeof parsed.probabilityOffset !== "number" || !Number.isFinite(parsed.probabilityOffset)) return 0;
    return Math.max(-0.5, Math.min(0.5, parsed.probabilityOffset));
  } catch {
    return 0;
  }
}

export const DEFAULT_POLICY_VERSION = "meridian-policy-v1.0" as const;

export const DEFAULT_POLICY_THRESHOLDS: JevPolicyThresholds = {
  autoApprove: 0.85,
  humanReview: 0.50,
  minConfidenceForAuto: 0.75,
};

export function evaluatePolicy(
  answers: Record<string, JevAnswer>,
  thresholds: JevPolicyThresholds = DEFAULT_POLICY_THRESHOLDS,
  policyVersion = DEFAULT_POLICY_VERSION,
): JevPolicyEvaluation {
  let supportingCount = 0;
  let violationCount = 0;
  let uncertainCount = 0;
  const collectedEvidence: EvidenceRef[] = [];
  const reasons: string[] = [];

  const answerList = Object.values(answers);
  if (answerList.length === 0) {
    return {
      decision: "HUMAN_REVIEW",
      reason: "No answers provided for evaluation.",
      policyVersion,
      thresholds,
      supportingCount: 0,
      violationCount: 0,
      uncertainCount: 1,
      evidenceRefs: [],
    };
  }

  let totalProb = 0;
  let probCount = 0;

  for (const item of answerList) {
    collectedEvidence.push(...item.evidenceRefs);
    const qSpec = getQuestionById(item.questionId);

    // 1. Check for explicit abstention or insufficient evidence or provider error
    if (item.status !== "answered") {
      uncertainCount++;
      reasons.push(`${item.questionId}: ${item.abstainReason || item.status}`);
      continue;
    }

    // 2. Check for explicit rejection criteria defined on question
    if (qSpec?.policyMapping?.rejectionValues) {
      if (typeof item.answer === "string" && qSpec.policyMapping.rejectionValues.includes(item.answer)) {
        violationCount++;
        reasons.push(`${item.questionId} triggered rejection condition: "${item.answer}"`);
      }
    }

    // 3. Evaluate boolean noul questions
    if (typeof item.answer === "boolean") {
      if (item.answer === true) {
        supportingCount++;
      } else {
        violationCount++;
        reasons.push(`${item.questionId} returned false (safety or compliance requirement not met)`);
      }
    }

    // 4. Probability / Score accumulation
    if (typeof item.probability === "number") {
      totalProb += item.probability;
      probCount++;
    }
  }

  // If any hard violation occurred, reject immediately
  if (violationCount > 0) {
    return {
      decision: "REJECT",
      reason: `Rejected due to ${violationCount} violation(s): ${reasons.join("; ")}`,
      policyVersion,
      thresholds,
      supportingCount,
      violationCount,
      uncertainCount,
      evidenceRefs: collectedEvidence,
    };
  }

  // If any question had missing/insufficient evidence or low confidence, auto-approve is forbidden
  const hasLowConfidence = answerList.some(
    (a) => a.confidence !== undefined && a.confidence < thresholds.minConfidenceForAuto,
  );

  if (uncertainCount > 0 || hasLowConfidence) {
    return {
      decision: "HUMAN_REVIEW",
      reason: `Requires human review due to missing evidence or uncertain answers (${uncertainCount} uncertain): ${reasons.join("; ")}`,
      policyVersion,
      thresholds,
      supportingCount,
      violationCount,
      uncertainCount,
      evidenceRefs: collectedEvidence,
    };
  }

  // Evaluate aggregate probability
  const avgProbability = probCount > 0 ? totalProb / probCount : supportingCount > 0 ? 0.9 : 0.5;

  if (avgProbability >= thresholds.autoApprove) {
    return {
      decision: "AUTO_APPROVE",
      reason: `All ${supportingCount} checks passed with strong confidence and probability ${avgProbability.toFixed(2)}.`,
      policyVersion,
      thresholds,
      supportingCount,
      violationCount,
      uncertainCount,
      evidenceRefs: collectedEvidence,
    };
  }

  if (avgProbability >= thresholds.humanReview) {
    return {
      decision: "HUMAN_REVIEW",
      reason: `Moderate probability ${avgProbability.toFixed(2)} sits between review and approval thresholds.`,
      policyVersion,
      thresholds,
      supportingCount,
      violationCount,
      uncertainCount,
      evidenceRefs: collectedEvidence,
    };
  }

  return {
    decision: "REJECT",
    reason: `Low probability ${avgProbability.toFixed(2)} is beneath human review threshold (${thresholds.humanReview}).`,
    policyVersion,
    thresholds,
    supportingCount,
    violationCount,
    uncertainCount,
    evidenceRefs: collectedEvidence,
  };
}
