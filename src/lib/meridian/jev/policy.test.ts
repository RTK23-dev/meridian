/**
 * A saved threshold version sets thresholds and the policy version. It is not calibration. These tests run the real loader
 * (jev/policy.ts) against the database, then the shared decision rule (jev/engine.ts decide).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { studioTenant } from "../../../test-support/lib/meridian/testing/durable-image-fixtures.ts";
import { decide, type CalibrationStep, type DecisionQuestion } from "./engine.ts";
import { loadAppliedPolicies, loadQuestionPolicy } from "./policy.ts";

type Input = { score: number; evidence: "present" | "missing" | "violation" };

const QUESTION_ID = "test.threshold_row.v1";

const question: DecisionQuestion<Input> = {
  id: QUESTION_ID,
  version: "1.0.0",
  description: "A score question with a saved threshold version.",
  thresholds: { autoApprove: 0.9, humanReview: 0.6, minConfidenceForAuto: 0.7 },
  evaluate: (input) => {
    if (input.evidence === "violation") {
      return {
        probability: input.score,
        confidence: 0.9,
        reasons: ["A measured violation."],
        evidence: [{ id: "v", source: "test", summary: "violation" }],
        evidenceState: "violation",
      };
    }
    if (input.evidence === "missing") {
      return { probability: 0, confidence: 0, reasons: ["No evidence was stored."], evidence: [], evidenceState: "missing" };
    }
    return {
      probability: input.score,
      confidence: 0.9,
      reasons: ["Measured."],
      evidence: [{ id: "e", source: "test", summary: "present" }],
    };
  },
};

/** The saved version. Its thresholds differ from the code policy, so the tests can see them take effect. */
const SAVED_THRESHOLDS = { autoApprove: 0.8, humanReview: 0.4 };

/** What a passing calibration report would supply. Nothing in the repo builds one for a question yet, so the test supplies it. */
const CALIBRATED: CalibrationStep = { version: "calibration-report.test.v1", apply: (score) => score };

async function saveThresholdVersion(sql: Sql, organizationId: string): Promise<void> {
  // The stored offset is ignored. The old code applied it as calibration, so it would have lifted a score into a decision.
  const stored = { ...SAVED_THRESHOLDS, probabilityOffset: 0.5 };
  await sql`
    insert into jev_threshold_versions (id, organization_id, question_id, version, thresholds, approved_by)
    values (${`thr-${organizationId}`}, ${organizationId}, ${QUESTION_ID}, 1, ${JSON.stringify(stored)}, 'reviewer')
  `;
}

async function withSavedVersion(label: string) {
  const sql = await getSql();
  const tenant = await studioTenant(sql, label);
  await saveThresholdVersion(sql, tenant.organizationId);
  const loaded = await loadQuestionPolicy(sql, tenant.organizationId, question);
  return { sql, tenant, ...loaded };
}

test("a saved threshold version sets the thresholds and the policy version, and sets no calibration", async () => {
  const { policy, question: applied } = await withSavedVersion("policy-row-not-calibration");
  assert.equal(policy.calibration, null);
  assert.equal(policy.policyVersion, `approved:${QUESTION_ID}.1`);
  assert.equal(applied.thresholds.autoApprove, SAVED_THRESHOLDS.autoApprove);
  assert.equal(applied.thresholds.humanReview, SAVED_THRESHOLDS.humanReview);
});

test("with only a saved threshold version, a score above the approval threshold is review, not approval", async () => {
  const { policy, question: applied } = await withSavedVersion("policy-row-approve");
  const decision = decide(applied, { score: 0.95, evidence: "present" }, {
    calibration: policy.calibration,
    policyVersion: policy.policyVersion,
  });
  assert.equal(decision.decision, "HUMAN_REVIEW");
  assert.equal(decision.calibrationVersion, null, "no calibration was applied");
  assert.equal(decision.policyVersion, `approved:${QUESTION_ID}.1`);
});

test("with only a saved threshold version, a score below the review line is review, not rejection", async () => {
  const { policy, question: applied } = await withSavedVersion("policy-row-reject");
  const decision = decide(applied, { score: 0.2, evidence: "present" }, {
    calibration: policy.calibration,
    policyVersion: policy.policyVersion,
  });
  assert.equal(decision.decision, "HUMAN_REVIEW");
  assert.equal(decision.calibrationVersion, null);
});

test("where a real calibration exists, the saved thresholds still permit automatic approval and rejection", async () => {
  const { policy, question: applied } = await withSavedVersion("policy-row-calibrated");
  const context = { calibration: CALIBRATED, policyVersion: policy.policyVersion };
  const approved = decide(applied, { score: 0.95, evidence: "present" }, context);
  assert.equal(approved.decision, "AUTO_APPROVE");
  assert.equal(approved.calibrationVersion, CALIBRATED.version);
  assert.equal(decide(applied, { score: 0.2, evidence: "present" }, context).decision, "REJECT");
});

test("a measured violation still rejects, and missing evidence still goes to review, with or without calibration", async () => {
  const { policy, question: applied } = await withSavedVersion("policy-row-categorical");
  for (const calibration of [null, CALIBRATED]) {
    const context = { calibration, policyVersion: policy.policyVersion };
    assert.equal(decide(applied, { score: 0.95, evidence: "violation" }, context).decision, "REJECT");
    assert.equal(decide(applied, { score: 0, evidence: "missing" }, context).decision, "HUMAN_REVIEW");
  }
});

test("the applied-policy map used by image QC carries the saved thresholds and no calibration", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "policy-row-applied");
  await saveThresholdVersion(sql, tenant.organizationId);
  const policy = (await loadAppliedPolicies(sql, tenant.organizationId)).get(QUESTION_ID);
  assert.ok(policy);
  assert.equal(policy.calibration, null);
  assert.equal(policy.thresholds.autoApprove, SAVED_THRESHOLDS.autoApprove);
});

test("with no saved version, the code policy applies and there is no calibration", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "policy-no-row");
  const { policy, question: applied } = await loadQuestionPolicy(sql, tenant.organizationId, question);
  assert.equal(policy.calibration, null);
  assert.equal(policy.policyVersion, `code:${QUESTION_ID}.1.0.0`);
  assert.deepEqual(applied.thresholds, question.thresholds);
});
