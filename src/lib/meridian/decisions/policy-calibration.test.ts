import assert from "node:assert/strict";
import test from "node:test";
import type { JevAnswer, JevQuestionSpec } from "../jev/types.ts";
import { applyCalibratedThreshold, evaluateQuestionPolicies, policyForQuestion, type AppliedCalibration } from "./policy.ts";

const SPEC: JevQuestionSpec = {
  id: "test.policy_calibration.v1",
  version: "1.0.0",
  type: "noul",
  instructions: "A pass-if-true predicate.",
  criteria: { true: "Holds.", false: "Does not hold." },
  evidenceRequirements: ["copy"],
  policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.9, reviewMinProbability: 0.6, thresholdCalibration: "uncalibrated" },
};

const CALIBRATION: AppliedCalibration = { reportId: "qcal-test", sampleSize: 100, threshold: 0.6 };

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

test("without a calibrated threshold an uncalibrated question's confident probability goes to review", () => {
  const result = evaluateQuestionPolicies({ k: probabilityAnswer(0.97) }, [{ questionId: SPEC.id, policy: policyForQuestion(SPEC) }]);
  assert.equal(result.outcome, "HUMAN_REVIEW");
  assert.equal(result.votes[0]?.calibrationStatus, "uncalibrated");
  assert.equal(result.votes[0]?.calibration, undefined);
});

test("under a calibrated threshold the same probability approves, and the vote names the report it came from", () => {
  const policy = applyCalibratedThreshold(policyForQuestion(SPEC)!, CALIBRATION);
  assert.equal(policy.approveMinProbability, 0.6, "the calibrated threshold replaces the registry's approve threshold");
  const result = evaluateQuestionPolicies({ k: probabilityAnswer(0.97) }, [{ questionId: SPEC.id, policy }]);
  assert.equal(result.outcome, "AUTO_APPROVE");
  assert.equal(result.votes[0]?.calibrationStatus, "calibrated");
  assert.deepEqual(result.votes[0]?.calibration, CALIBRATION);
});

test("under a calibrated threshold a probability below it does not approve", () => {
  const policy = applyCalibratedThreshold(policyForQuestion(SPEC)!, CALIBRATION);
  const result = evaluateQuestionPolicies({ k: probabilityAnswer(0.55) }, [{ questionId: SPEC.id, policy }]);
  assert.notEqual(result.outcome, "AUTO_APPROVE");
});

test("a reject-if-true predicate is never calibrated by a report: its policy is returned unchanged", () => {
  const defect: JevQuestionSpec = {
    ...SPEC,
    id: "test.defect.v1",
    policyMapping: { predicateDirection: "reject_if_true", approveMinProbability: 0.9, reviewMinProbability: 0.6 },
  };
  const policy = policyForQuestion(defect)!;
  assert.equal(applyCalibratedThreshold(policy, CALIBRATION), policy);
});
