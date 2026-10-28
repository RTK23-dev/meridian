import { unselectedOpenRouterEngine } from "../../../test-support/lib/meridian/testing/openrouter-engine-stub.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import { runEngineGate, type GateResult } from "../decisions/gate.ts";
import { studioTenant } from "../../../test-support/lib/meridian/testing/durable-image-fixtures.ts";
import { COPY_EVIDENCE, GRADED_QUESTION, probabilityEngine, type Tenant } from "../../../test-support/lib/meridian/testing/question-calibration-fixtures.ts";
import { QUESTION_CALIBRATION_METHOD } from "./question-method.ts";
import { recordQuestionCalibrations, type CalibrationScope } from "./question-store.ts";

// The registry's thresholds for the graded question: approve at 0.9, review at 0.6.

function scopeOf(tenant: Tenant): CalibrationScope {
  return { organizationId: tenant.organizationId, brandId: tenant.brandId };
}

/** The engine gate on one graded question, answered with the given probability. The gate reads the brand's calibrated threshold. */
async function gateFor(sql: Awaited<ReturnType<typeof getSql>>, tenant: Tenant, probability: number): Promise<GateResult> {
  return runEngineGate({
    sql,
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    gate: "factory_grade",
    subject: { type: "research_ad", id: `ad-${globalThis.crypto.randomUUID()}` },
    description: "A stored ad, read as a creative concept.",
    questions: [{ key: "graded", spec: GRADED_QUESTION, needsImage: false, evidenceScope: ["copy"] }],
    evidence: [COPY_EVIDENCE],
    selection: { engineId: "jev", source: "workspace" },
    engines: { jev: probabilityEngine("jev", probability), "openai-decisions": probabilityEngine("openai-decisions", null), "openrouter-decisions": unselectedOpenRouterEngine() },
  });
}

/** A calibrated report for the graded question, stored for the tenant. Its threshold is the value the report measured. */
async function insertCalibratedReport(sql: Awaited<ReturnType<typeof getSql>>, tenant: Tenant, reportId: string, threshold: number): Promise<void> {
  await sql`
    insert into question_calibration_reports (id, organization_id, brand_id, question_id, question_version, method_version, status, reason, sample_size, thresholds, reliability)
    values (${reportId}, ${tenant.organizationId}, ${tenant.brandId}, ${GRADED_QUESTION.id}, ${GRADED_QUESTION.version}, ${QUESTION_CALIBRATION_METHOD},
      'calibrated', 'fixture', 100, ${JSON.stringify({ approveMinProbability: threshold })}, '[]')
  `;
}

const REGISTRY_VERSION = `${GRADED_QUESTION.id}@${GRADED_QUESTION.version}`;

test("below the minimum sample the brand's grade stays uncalibrated, and the gate routes it to review", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "qcal-gate-below");
  // No outcomes: the stored report is uncalibrated, "0 of 100 observations measured".
  await recordQuestionCalibrations(sql, scopeOf(tenant), [{ questionId: GRADED_QUESTION.id, questionVersion: GRADED_QUESTION.version }]);

  const result = await gateFor(sql, tenant, 0.97);
  assert.equal(result.action, "HUMAN_REVIEW", "a confident probability under an uncalibrated threshold goes to review");
  assert.equal(result.votes[0]?.calibrationStatus, "uncalibrated");
  assert.equal(result.votes[0]?.calibration, undefined, "no report is named when none applies");
  assert.equal(result.policyVersion, REGISTRY_VERSION, "the version is the registry's, unchanged");
});

test("at the minimum sample a calibrated threshold above the registry's raises the bar: 0.97 approves, and the vote names its report", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "qcal-gate-calibrated");
  const reportId = `qcal-gate-${Math.random().toString(36).slice(2, 10)}`;
  await insertCalibratedReport(sql, tenant, reportId, 0.95);

  const result = await gateFor(sql, tenant, 0.97);
  assert.equal(result.action, "AUTO_APPROVE", "0.97 is above the calibrated threshold of 0.95");
  const vote = result.votes[0];
  assert.equal(vote?.calibrationStatus, "calibrated");
  assert.deepEqual(vote?.calibration, { reportId, sampleSize: 100, threshold: 0.95 });
  assert.equal(result.policyVersion, `${REGISTRY_VERSION}+calibrated:${reportId}`, "the record names the report");
});

test("a calibrated threshold above the registry's threshold raises the bar: 0.92 no longer approves", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "qcal-gate-raise");
  const reportId = `qcal-raise-${Math.random().toString(36).slice(2, 10)}`;
  await insertCalibratedReport(sql, tenant, reportId, 0.95);

  // 0.92 clears the registry's 0.9. Under the calibrated 0.95 it is calibrated and sent to review.
  const result = await gateFor(sql, tenant, 0.92);
  assert.equal(result.action, "HUMAN_REVIEW");
  assert.equal(result.votes[0]?.calibrationStatus, "calibrated");
  assert.equal(result.votes[0]?.calibration?.threshold, 0.95);
  assert.equal(result.policyVersion, `${REGISTRY_VERSION}+calibrated:${reportId}`);
});

test("a calibrated threshold below the registry's approve threshold does not lower the bar", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "qcal-gate-lower");
  const reportId = `qcal-lower-${Math.random().toString(36).slice(2, 10)}`;
  // 0.7 is above the registry's review threshold of 0.6 but below its approve threshold of 0.9.
  await insertCalibratedReport(sql, tenant, reportId, 0.7);

  // 0.85 would approve under the calibrated 0.7. The registry's 0.9 stands, and the report is not applied.
  const result = await gateFor(sql, tenant, 0.85);
  assert.equal(result.action, "HUMAN_REVIEW", "the bar is not lowered to 0.7");
  assert.equal(result.votes[0]?.calibrationStatus, "uncalibrated");
  assert.equal(result.votes[0]?.calibration, undefined, "the lower report is not named on the vote");
  assert.equal(result.policyVersion, REGISTRY_VERSION, "the record does not name a report that was not applied");
});

test("another brand's calibrated report is never applied to this brand", async () => {
  const sql = await getSql();
  const brand = await studioTenant(sql, "qcal-gate-owner");
  const other = await studioTenant(sql, "qcal-gate-stranger");
  await insertCalibratedReport(sql, brand, `qcal-owner-${Math.random().toString(36).slice(2, 10)}`, 0.95);

  const result = await gateFor(sql, other, 0.97);
  assert.equal(result.action, "HUMAN_REVIEW");
  assert.equal(result.votes[0]?.calibrationStatus, "uncalibrated");
  assert.equal(result.votes[0]?.calibration, undefined);
});
