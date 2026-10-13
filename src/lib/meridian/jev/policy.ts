/**
 * JEV approved threshold versions, per question.
 *
 * A workspace can save a threshold version for a question. The latest one replaces the code thresholds for that question and
 * sets the policy version. A threshold version is not calibration: it sets no calibration step, so a numeric score routes to
 * review and is never auto-decided on its own (engine.ts decide). The deterministic decision for a question is made in
 * decisions/gate.ts and studio/image-qc.server.ts, never here.
 */

import { approvedThresholds } from "../calibration/active.ts";
import type { CalibrationStep, DecisionQuestion, ThresholdConfig } from "./engine.ts";
import type { Sql } from "../learning/store.ts";

export type AppliedPolicy = {
  thresholds: ThresholdConfig;
  policyVersion: string;
  /**
   * Only a stored calibration report that passes the held-out gate (learning/calibration-gate.ts) may set this. A threshold
   * version never does. No code path builds one from a question's stored data yet, so it is null for every question, and
   * numeric scores route to review (engine.ts decide).
   */
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
  // A threshold version changes the thresholds and the policy version only. It sets no calibration, so an uncalibrated score
  // cannot be auto-decided because a row exists. Any stored offset in the row is ignored.
  const thresholds = approvedThresholds(fallback, { thresholds: row.thresholds });
  const version = Number(row.version);
  return {
    thresholds,
    policyVersion: `approved:${questionId}.${version}`,
    calibration: null,
  };
}
