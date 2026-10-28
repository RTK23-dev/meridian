import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import { studioTenant } from "../../../test-support/lib/meridian/testing/durable-image-fixtures.ts";
import {
  GRADED_QUESTION,
  gradeResearchAd,
  recordMeasuredRow,
  seedAdTimeline,
  seedPick,
  seedResearchAd,
  type Tenant,
} from "../../../test-support/lib/meridian/testing/question-calibration-fixtures.ts";
import { predictionFingerprint } from "../factory/prediction.ts";
import { QUESTION_CALIBRATION_METHOD } from "./question-method.ts";
import { buildQuestionOutcomes, questionKeyOf } from "./question-outcomes.ts";
import {
  calibratedThresholdsOf,
  latestQuestionCalibrations,
  loadQuestionOutcomeInputs,
  measureQuestionCalibrations,
  recordQuestionCalibrations,
  type CalibrationScope,
} from "./question-store.ts";

const QUESTION = { questionId: GRADED_QUESTION.id, questionVersion: GRADED_QUESTION.version };
const KEY = questionKeyOf(QUESTION.questionId, QUESTION.questionVersion);

function scopeOf(tenant: Tenant): CalibrationScope {
  return { organizationId: tenant.organizationId, brandId: tenant.brandId };
}

async function countReports(sql: Awaited<ReturnType<typeof getSql>>, scope: CalibrationScope): Promise<number> {
  const rows = await sql<{ n: number | string }>`
    select count(*) as n from question_calibration_reports
    where organization_id = ${scope.organizationId} and brand_id = ${scope.brandId}
  `;
  return Number(rows[0]?.n ?? 0);
}

test("recomputing the same data stores one report, and the newest report is the one read", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "qcal-same");
  const scope = scopeOf(tenant);
  const questions = [{ questionId: "test.calibration.v1", questionVersion: "1.0.0" }];

  const first = await recordQuestionCalibrations(sql, scope, questions);
  const second = await recordQuestionCalibrations(sql, scope, questions);
  assert.equal(first[0]!.stored, true);
  assert.equal(second[0]!.stored, false, "the same content is not stored again");
  assert.equal(second[0]!.reportId, first[0]!.reportId);
  assert.equal(await countReports(sql, scope), 1);

  const latest = await latestQuestionCalibrations(sql, scope, questions);
  const report = latest.get(questionKeyOf("test.calibration.v1", "1.0.0"));
  assert.equal(report?.status, "uncalibrated");
  assert.equal(report?.sampleSize, 0);
  assert.equal(report?.methodVersion, QUESTION_CALIBRATION_METHOD);
  assert.match(report?.reason ?? "", /^0 of 100 observations measured\./);
  assert.equal(report?.threshold, null, "an uncalibrated report gives no threshold");
});

test("the gate reads a calibrated threshold only for the brand that stored it, and only when it is the newest report", async () => {
  const sql = await getSql();
  const brand = await studioTenant(sql, "qcal-read-a");
  const other = await studioTenant(sql, "qcal-read-b");
  const questions = [{ questionId: "test.calibration.v1", questionVersion: "1.0.0" }];
  const key = questionKeyOf("test.calibration.v1", "1.0.0");
  const suffix = Math.random().toString(36).slice(2, 8);
  const calibratedId = `qcal-old-${suffix}`;
  const uncalibratedId = `qcal-new-${suffix}`;

  await sql`
    insert into question_calibration_reports (id, organization_id, brand_id, question_id, question_version, method_version, status, reason, sample_size, thresholds, reliability, created_at)
    values (${calibratedId}, ${brand.organizationId}, ${brand.brandId}, 'test.calibration.v1', '1.0.0', ${QUESTION_CALIBRATION_METHOD},
      'calibrated', 'fixture', 100, ${JSON.stringify({ approveMinProbability: 0.6 })}, '[]', '2026-01-01T00:00:00Z'::timestamptz)
  `;
  assert.deepEqual(
    (await calibratedThresholdsOf(sql, scopeOf(brand), questions)).get(key),
    { reportId: calibratedId, sampleSize: 100, threshold: 0.6 },
  );
  assert.equal((await calibratedThresholdsOf(sql, scopeOf(other), questions)).size, 0, "another brand has no threshold");

  await sql`
    insert into question_calibration_reports (id, organization_id, brand_id, question_id, question_version, method_version, status, reason, sample_size, thresholds, reliability, created_at)
    values (${uncalibratedId}, ${brand.organizationId}, ${brand.brandId}, 'test.calibration.v1', '1.0.0', ${QUESTION_CALIBRATION_METHOD},
      'uncalibrated', 'fixture', 40, '{}', '[]', '2026-02-01T00:00:00Z'::timestamptz)
  `;
  assert.equal((await calibratedThresholdsOf(sql, scopeOf(brand), questions)).size, 0, "the newest report is uncalibrated, so no threshold applies");
  const latest = await latestQuestionCalibrations(sql, scopeOf(brand), questions);
  assert.equal(latest.get(key)?.id, uncalibratedId);
});

test("a graded pick with a measured creative is one observation of its own brand, and another brand's rows never count", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "qcal-chain");
  const other = await studioTenant(sql, "qcal-chain-other");
  const suffix = Math.random().toString(36).slice(2, 10);
  const researchAdId = await seedResearchAd(sql, tenant, suffix);
  const graded = await gradeResearchAd(sql, tenant, { researchAdId, probability: 0.97 });
  await seedAdTimeline(sql, tenant, researchAdId, graded.grade, suffix);
  const creativeId = `cr-${suffix}`;
  await seedPick(sql, tenant, {
    runId: `run-${suffix}`,
    pickId: `pick-${suffix}`,
    researchAdId,
    surface: "paid",
    fingerprint: predictionFingerprint(graded.grade),
    creativeId,
    suffix,
  });
  // This creative's click-through rate is 0.05. Two other creatives are 0.09 and 0.10, so the median is 0.09 and the pick does not beat it.
  await recordMeasuredRow(sql, tenant, { id: `m1-${suffix}`, creativeId, surface: "paid", clicks: 5, impressions: 100 });
  await recordMeasuredRow(sql, tenant, { id: `m2-${suffix}`, creativeId: `cr-b-${suffix}`, surface: "paid", clicks: 9, impressions: 100 });
  await recordMeasuredRow(sql, tenant, { id: `m3-${suffix}`, creativeId: `cr-c-${suffix}`, surface: "paid", clicks: 10, impressions: 100 });
  // The other brand has measured creatives of its own and no picks. Its median is 0.45.
  await recordMeasuredRow(sql, other, { id: `o1-${suffix}`, creativeId: `ocr-a-${suffix}`, surface: "paid", clicks: 40, impressions: 100 });
  await recordMeasuredRow(sql, other, { id: `o2-${suffix}`, creativeId: `ocr-b-${suffix}`, surface: "paid", clicks: 50, impressions: 100 });

  const build = buildQuestionOutcomes(await loadQuestionOutcomeInputs(sql, scopeOf(tenant)));
  assert.equal(build.baselines.paid, 0.09);
  assert.deepEqual(build.questions.get(KEY)?.observations, [{ predicted: 0.97, success: false }]);

  const measured = await measureQuestionCalibrations(sql, scopeOf(tenant), [QUESTION]);
  assert.equal(measured.questions.get(KEY)?.calibration.sampleSize, 1);

  const otherMeasured = await measureQuestionCalibrations(sql, scopeOf(other), [QUESTION]);
  assert.equal(otherMeasured.questions.get(KEY)?.calibration.sampleSize, 0, "another brand's outcomes are not this brand's observations");
  assert.ok(Math.abs((otherMeasured.baselines.paid ?? Number.NaN) - 0.45) < 1e-9, "another brand's baseline is its own median");

  const [recorded] = await recordQuestionCalibrations(sql, scopeOf(tenant), [QUESTION]);
  assert.equal(recorded?.calibration.status, "uncalibrated");
  assert.match(recorded?.calibration.reason ?? "", /^1 of 100 observations measured\./);
});
