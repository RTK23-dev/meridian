// What a repurpose decision check may say, from fixtures of the gate's result. No engine is called: the mapping is pure, and the states it names are
// the ones the UI and the database record. The rule under test: a check is a verdict only with a calibrated threshold. An uncalibrated answer
// is never an approval or a rejection, a failed engine is not a judgement, and every state is advisory.

import assert from "node:assert/strict";
import test from "node:test";
import type { GateResult } from "../decisions/gate.ts";
import { judgeRepurposePlan, repurposeCheckOf } from "./repurpose-gate.ts";

type Vote = { calibrationStatus: "calibrated" | "uncalibrated" | "not_applicable" };

/** A gate result with only the fields the check reads. Every other field is left out, and the check does not read it. */
function result(fields: { action: GateResult["action"]; engineCalled?: boolean; failureKind?: string; votes?: Vote[]; reason?: string }): GateResult {
  return {
    action: fields.action,
    reason: fields.reason ?? "",
    engineCalled: fields.engineCalled ?? true,
    engineId: fields.engineCalled === false ? null : "openrouter-decisions",
    failureKind: fields.failureKind,
    votes: (fields.votes ?? []).map((vote) => ({ ...vote, scope: [], model: null, runId: null, questionId: "q", outcome: fields.action, reason: "" })),
    gateRecordId: "gate_fixture",
  } as unknown as GateResult;
}

test("with no engine configured, the check is not configured, and nothing is judged", () => {
  const check = repurposeCheckOf(result({ action: "REVIEW", engineCalled: false, failureKind: "not_configured" }));
  assert.equal(check.state, "not_configured");
  assert.equal(check.outcome, "not_consulted");
  assert.equal(check.engineId, null);
});

test("when the selected engine cannot be reached, the check is not consulted, not a review", () => {
  const check = repurposeCheckOf(result({ action: "REVIEW", engineCalled: false, failureKind: "selection_unavailable" }));
  assert.equal(check.state, "not_consulted");
  assert.equal(check.outcome, "not_consulted");
});

test("an engine that was called and failed is a failed check, never an approval or a rejection", () => {
  for (const action of ["AUTO_APPROVE", "REJECT", "REVIEW"] as const) {
    const check = repurposeCheckOf(result({ action, failureKind: "provider_unavailable", votes: [{ calibrationStatus: "calibrated" }] }));
    assert.equal(check.state, "failed", `a failure with ${action} is still a failure`);
    assert.equal(check.outcome, "not_consulted");
  }
});

test("an uncalibrated approval is never an approval: it is uncalibrated, and it is a note for review", () => {
  const check = repurposeCheckOf(result({ action: "AUTO_APPROVE", votes: [{ calibrationStatus: "uncalibrated" }] }));
  assert.equal(check.state, "uncalibrated");
  assert.equal(check.outcome, "review");
});

test("an uncalibrated rejection is never a rejection: it cannot stop a plan", () => {
  const check = repurposeCheckOf(result({ action: "REJECT", votes: [{ calibrationStatus: "uncalibrated" }] }));
  assert.equal(check.state, "uncalibrated", "the answer is recorded as uncalibrated, not rejected");
  assert.notEqual(check.outcome, "rejected");
});

test("a calibrated approval is the only approval, and a calibrated rejection the only rejection", () => {
  assert.equal(repurposeCheckOf(result({ action: "AUTO_APPROVE", votes: [{ calibrationStatus: "calibrated" }] })).state, "approved");
  assert.equal(repurposeCheckOf(result({ action: "REJECT", votes: [{ calibrationStatus: "calibrated" }] })).state, "rejected");
});

test("a calibrated review is review required, and a review with no calibration says so", () => {
  assert.equal(repurposeCheckOf(result({ action: "REVIEW", votes: [{ calibrationStatus: "calibrated" }] })).state, "review_required");
  assert.equal(repurposeCheckOf(result({ action: "REVIEW", votes: [{ calibrationStatus: "uncalibrated" }] })).state, "uncalibrated");
});

test("every state is advisory, and every state names the question's engine only when one answered", () => {
  const cases = [
    result({ action: "AUTO_APPROVE", votes: [{ calibrationStatus: "calibrated" }] }),
    result({ action: "REJECT", votes: [{ calibrationStatus: "calibrated" }] }),
    result({ action: "REVIEW", votes: [{ calibrationStatus: "uncalibrated" }] }),
    result({ action: "REVIEW", engineCalled: false, failureKind: "not_configured" }),
    result({ action: "REVIEW", failureKind: "timeout" }),
  ];
  for (const fixture of cases) {
    const check = repurposeCheckOf(fixture);
    assert.equal(check.authority, "advisory");
  }
  assert.equal(repurposeCheckOf(cases[3]!).engineId, null, "no engine answered, so no engine is named");
});

test("a plan with no brand is not consulted, and no engine is asked", async () => {
  const check = await judgeRepurposePlan({
    sql: null as never,
    organizationId: "org_none",
    brandId: null,
    subjectId: "plan_none",
    variations: [],
  });
  assert.equal(check.state, "not_consulted");
  assert.equal(check.authority, "advisory");
});
