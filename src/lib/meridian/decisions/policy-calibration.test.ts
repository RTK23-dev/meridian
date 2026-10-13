import assert from "node:assert/strict";
import test from "node:test";
import type { JevAnswer, JevQuestionSpec } from "../jev/types.ts";
import { applyCalibratedThreshold, calibrationRaisesBar, evaluateQuestionPolicies, policyForQuestion, type AppliedCalibration } from "./policy.ts";

// The registry's thresholds for this question: approve at 0.9, review at 0.6. Its thresholds are uncalibrated.
const SPEC: JevQuestionSpec = {
  id: "test.policy_calibration.v1",
  version: "1.0.0",
  type: "noul",
  instructions: "A pass-if-true predicate.",
  criteria: { true: "Holds.", false: "Does not hold." },
  evidenceRequirements: ["copy"],
  policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.9, reviewMinProbability: 0.6, thresholdCalibration: "uncalibrated" },
};

function calibration(threshold: number): AppliedCalibration {
  return { reportId: `qcal-${threshold}`, sampleSize: 100, threshold };
}

function probabilityAnswer(probability: number): JevAnswer {
  return {
    questionId: SPEC.id,
    questionVersion: SPEC.version,
    type: "noul",
    model: "fixture-model",
    provider: "fixture",
    status: "answered",
    answer: probability >= 0.5,
    probability,
    noul: probability,
    semantics: "probability",
    calibrationStatus: "uncalibrated",
    evidenceRefs: [],
    evaluatedAt: "2026-10-13T00:00:00.000Z",
  } as JevAnswer;
}

function evaluate(probability: number, policy = policyForQuestion(SPEC)!) {
  return evaluateQuestionPolicies({ k: probabilityAnswer(probability) }, [{ questionId: SPEC.id, policy }]);
}

test("without a calibrated threshold an uncalibrated question's confident probability goes to review", () => {
  const result = evaluate(0.97);
  assert.equal(result.outcome, "HUMAN_REVIEW");
  assert.equal(result.votes[0]?.calibrationStatus, "uncalibrated");
  assert.equal(result.votes[0]?.calibration, undefined);
});

test("a calibrated threshold above the registry's approve threshold raises the bar", () => {
  const raised = applyCalibratedThreshold(policyForQuestion(SPEC)!, calibration(0.95));
  assert.equal(raised.approveMinProbability, 0.95, "the bar is raised from the registry's 0.9");

  // 0.92 clears the registry's 0.9, so it would approve at that level. Under the raised bar it does not approve.
  const atRegistryLevel = applyCalibratedThreshold(policyForQuestion(SPEC)!, calibration(0.9));
  assert.equal(evaluate(0.92, atRegistryLevel).outcome, "AUTO_APPROVE");
  const belowRaisedBar = evaluate(0.92, raised);
  assert.equal(belowRaisedBar.outcome, "HUMAN_REVIEW");
  assert.equal(belowRaisedBar.votes[0]?.calibrationStatus, "calibrated");

  const approved = evaluate(0.97, raised);
  assert.equal(approved.outcome, "AUTO_APPROVE");
  assert.equal(approved.votes[0]?.calibrationStatus, "calibrated");
  assert.deepEqual(approved.votes[0]?.calibration, calibration(0.95), "the vote names the report it came from");
});

test("a calibrated threshold below the registry's approve threshold does not lower the bar, even above the review threshold", () => {
  const policy = applyCalibratedThreshold(policyForQuestion(SPEC)!, calibration(0.75));
  assert.equal(policy.approveMinProbability, 0.9, "the registry's threshold stands");
  assert.equal(policy.calibration, undefined, "the report is not applied");
  // 0.85 would approve under the calibrated 0.75, but it does not approve under the registry's 0.9.
  const result = evaluate(0.85, policy);
  assert.notEqual(result.outcome, "AUTO_APPROVE");
  assert.equal(result.votes[0]?.calibrationStatus, "uncalibrated");
  assert.equal(result.votes[0]?.calibration, undefined);
});

test("a calibrated threshold below the registry's review threshold does not lower the bar either", () => {
  const policy = applyCalibratedThreshold(policyForQuestion(SPEC)!, calibration(0.4));
  assert.equal(policy.approveMinProbability, 0.9);
  assert.equal(policy.calibration, undefined);
  const result = evaluate(0.5, policy);
  assert.notEqual(result.outcome, "AUTO_APPROVE");
  assert.equal(result.votes[0]?.calibrationStatus, "uncalibrated");
});

test("a calibrated threshold equal to the registry's approve threshold is applied, and anything below it is not", () => {
  const base = policyForQuestion(SPEC)!;
  assert.equal(calibrationRaisesBar(base, 0.9), true);
  assert.equal(calibrationRaisesBar(base, 0.8999), false);
  assert.equal(calibrationRaisesBar(base, 1), true);
});

test("a question with no registry approve threshold is never calibrated: it still cannot approve", () => {
  const noApprove: JevQuestionSpec = {
    ...SPEC,
    id: "test.no_approve.v1",
    policyMapping: { predicateDirection: "pass_if_true", reviewMinProbability: 0.6, thresholdCalibration: "uncalibrated" },
  };
  const policy = policyForQuestion(noApprove)!;
  assert.equal(applyCalibratedThreshold(policy, calibration(0.95)), policy);
});

test("a reject-if-true predicate is never calibrated by a report: its policy is returned unchanged", () => {
  const defect: JevQuestionSpec = {
    ...SPEC,
    id: "test.defect.v1",
    policyMapping: { predicateDirection: "reject_if_true", approveMinProbability: 0.9, reviewMinProbability: 0.6 },
  };
  const policy = policyForQuestion(defect)!;
  assert.equal(applyCalibratedThreshold(policy, calibration(0.99)), policy);
});
