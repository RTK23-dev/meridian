import assert from "node:assert/strict";
import test from "node:test";
import { evaluateQuestionPolicies, policyForQuestion } from "../../decisions/policy.ts";
import { UNIFIED_QUESTION_REGISTRY } from "../registry.ts";
import type { JevAnswer } from "../types.ts";

const UNCALIBRATED_SPECS = ["market.competitive_strength.v1", "production.reproducibility.v1"];

test("the competitive strength and reproducibility specs are registered and mark their thresholds uncalibrated", () => {
  for (const id of UNCALIBRATED_SPECS) {
    const spec = UNIFIED_QUESTION_REGISTRY[id];
    assert.ok(spec, `${id} is in the registry`);
    assert.equal(spec.id, id);
    assert.equal(spec.policyMapping?.thresholdCalibration, "uncalibrated", `${id} marks its thresholds uncalibrated`);
    assert.equal(policyForQuestion(spec)?.thresholdCalibration, "uncalibrated", `${id} carries the mark into its policy`);
  }
});

test("a confident probability under an uncalibrated threshold goes to review, whatever the engine reports", () => {
  const spec = UNIFIED_QUESTION_REGISTRY["market.competitive_strength.v1"];
  const policy = policyForQuestion(spec);
  for (const probability of [0.99, 0.5, 0.01]) {
    for (const calibrationStatus of ["calibrated", "uncalibrated", undefined] as const) {
      const answer = {
        questionId: spec.id,
        questionVersion: spec.version,
        type: "noul",
        model: "fixture-model",
        provider: "fixture",
        status: "answered",
        answer: probability,
        probability,
        semantics: "probability",
        calibrationStatus,
        evidenceRefs: [],
        evaluatedAt: "2026-10-13T00:00:00.000Z",
      } as JevAnswer;
      const result = evaluateQuestionPolicies({ k: answer }, [{ questionId: spec.id, policy }]);
      assert.equal(result.outcome, "HUMAN_REVIEW", `probability ${probability}, calibration ${calibrationStatus}`);
      assert.equal(result.votes[0]?.calibrationStatus, "uncalibrated");
    }
  }
});

test("a policy without the mark keeps the engine's reported calibration", () => {
  const spec = UNIFIED_QUESTION_REGISTRY["brand.positioning_fit.v1"];
  const policy = policyForQuestion(spec);
  assert.equal(policy?.thresholdCalibration, undefined);
  const answer = {
    questionId: spec.id,
    questionVersion: spec.version,
    type: "noul",
    model: "fixture-model",
    provider: "fixture",
    status: "answered",
    answer: 0.97,
    probability: 0.97,
    semantics: "probability",
    calibrationStatus: "calibrated",
    evidenceRefs: [],
    evaluatedAt: "2026-10-13T00:00:00.000Z",
  } as JevAnswer;
  const result = evaluateQuestionPolicies({ k: answer }, [{ questionId: spec.id, policy }]);
  assert.equal(result.votes[0]?.calibrationStatus, "calibrated");
});
