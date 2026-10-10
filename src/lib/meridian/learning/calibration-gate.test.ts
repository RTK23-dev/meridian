import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { HELD_OUT_MINIMUM, learnedWeightUsable, recordCalibrationReport, resolveParameterForUse } from "./calibration-gate.ts";
import { upsertModelParameter } from "./parameters.ts";

const improved = { decisionClass: "hook_weight", heldOutCount: HELD_OUT_MINIMUM, brierBefore: 0.25, brierAfter: 0.2 };

test("with no report, a learned value is not usable", () => {
  const gate = learnedWeightUsable(null);
  assert.equal(gate.usable, false);
  assert.ok(!gate.usable && gate.reason.includes("no calibration report"));
});

test("a report with fewer held-out outcomes than the minimum is not usable, however good its scores", () => {
  const gate = learnedWeightUsable({ ...improved, heldOutCount: HELD_OUT_MINIMUM - 1 });
  assert.equal(gate.usable, false);
  assert.ok(!gate.usable && gate.reason.includes(`${HELD_OUT_MINIMUM - 1} held-out outcomes`));
});

test("a change that does not improve held-out prediction is not usable, even with enough outcomes", () => {
  assert.equal(learnedWeightUsable({ ...improved, brierAfter: improved.brierBefore }).usable, false);
  assert.equal(learnedWeightUsable({ ...improved, brierAfter: 0.3 }).usable, false);
});

test("non-finite scores are not usable", () => {
  assert.equal(learnedWeightUsable({ ...improved, brierAfter: Number.NaN }).usable, false);
  assert.equal(learnedWeightUsable({ ...improved, brierBefore: Number.POSITIVE_INFINITY }).usable, false);
});

test("a report with enough outcomes that improves held-out prediction is usable", () => {
  assert.deepEqual(learnedWeightUsable(improved), { usable: true });
});

test("a parameter cannot be promoted to fitted without a stored calibration report", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "calib-refuse");
  await assert.rejects(
    upsertModelParameter(sql, {
      organizationId: tenant.organizationId,
      brandId: tenant.brandId,
      parameterName: "hook_weight",
      state: "fitted",
      sampleSize: 60,
      priorValue: 0.5,
      posteriorValue: 0.7,
    }),
    /Cannot promote parameter to 'fitted': no calibration report exists/,
  );
});

test("a stored report that improves held-out prediction lets the parameter be promoted, and its learned value is then in use", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "calib-accept");
  const ref = { organizationId: tenant.organizationId, brandId: tenant.brandId, decisionClass: "hook_weight" };
  await recordCalibrationReport(sql, ref, improved);
  await upsertModelParameter(sql, {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    parameterName: "hook_weight",
    state: "fitted",
    sampleSize: 60,
    priorValue: 0.5,
    posteriorValue: 0.7,
  });
  const resolved = await resolveParameterForUse(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, parameterName: "hook_weight" });
  assert.ok(resolved);
  assert.equal(resolved.source, "LEARNED");
  assert.equal(resolved.value, 0.7);
  assert.equal(resolved.sampleSize, 60, "the learned value is shown with its sample size");
  assert.equal(resolved.reason, null);
});

test("a fitted parameter whose latest report no longer passes falls back to the seed prior, and says why", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "calib-fallback");
  const ref = { organizationId: tenant.organizationId, brandId: tenant.brandId, decisionClass: "hook_weight" };
  await recordCalibrationReport(sql, ref, improved);
  await upsertModelParameter(sql, {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    parameterName: "hook_weight",
    state: "fitted",
    sampleSize: 60,
    priorValue: 0.5,
    posteriorValue: 0.7,
  });
  // A later report that does not improve prediction supersedes the earlier one.
  await recordCalibrationReport(sql, ref, { ...improved, brierAfter: 0.3 });
  const resolved = await resolveParameterForUse(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, parameterName: "hook_weight" });
  assert.ok(resolved);
  assert.equal(resolved.source, "seed_prior");
  assert.equal(resolved.value, 0.5, "the prior is used, not the learned posterior");
  assert.ok(resolved.reason?.includes("does not improve"));
});

test("a seed-prior parameter always resolves to its prior, with no learned value in use", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "calib-seed");
  await upsertModelParameter(sql, {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    parameterName: "hook_weight",
    state: "seed_prior",
    sampleSize: 3,
    priorValue: 0.5,
  });
  const resolved = await resolveParameterForUse(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, parameterName: "hook_weight" });
  assert.ok(resolved);
  assert.equal(resolved.source, "seed_prior");
  assert.equal(resolved.value, 0.5);
});
