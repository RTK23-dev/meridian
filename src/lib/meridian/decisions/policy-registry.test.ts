import assert from "node:assert/strict";
import test from "node:test";
import { UNIFIED_QUESTION_REGISTRY } from "../jev/registry.ts";
import type { JevAnswer, JevQuestionSpec } from "../jev/types.ts";
import { evaluateQuestionPolicies, policyForQuestion, policyVersionOf } from "./policy.ts";

test("every registry question maps to a versioned policy, and the policy version names that question and its version", () => {
  const entries = Object.entries(UNIFIED_QUESTION_REGISTRY);
  assert.ok(entries.length > 0);
  for (const [key, spec] of entries) {
    assert.ok(policyForQuestion(spec), `${key} (${spec.id}) has a policy`);
    assert.equal(policyVersionOf(spec), `${spec.id}@${spec.version}`, `${key} records its version`);
    assert.doesNotMatch(policyVersionOf(spec), /no-policy/, `${key} is not recorded as unmapped`);
  }
});

test("a registry question whose policy mapping names no approval rule can never approve, whatever it answers", () => {
  // The analysis questions map to review only. A confident answer from one of them still cannot approve.
  const reviewOnly = Object.values(UNIFIED_QUESTION_REGISTRY).filter(
    (spec) => spec.policyMapping && spec.policyMapping.approveMinProbability === undefined && spec.policyMapping.approveValues === undefined && spec.policyMapping.approveMinScore === undefined,
  );
  assert.ok(reviewOnly.length >= 5, "the analysis questions with no approval rule are present");
  for (const spec of reviewOnly) {
    const answer: JevAnswer = {
      questionId: spec.id,
      questionVersion: spec.version,
      type: spec.type,
      model: "stub",
      provider: "stub",
      status: "answered",
      answer: spec.type === "noul" ? 0.99 : spec.type === "score" ? 5 : "any",
      probability: spec.type === "noul" ? 0.99 : undefined,
      score: spec.type === "score" ? 5 : undefined,
      choice: spec.type === "choice" ? "any" : undefined,
      semantics: spec.type === "noul" ? "probability" : spec.type === "score" ? "ordered_score" : "categorical",
      calibrationStatus: "calibrated",
      evidenceRefs: [],
      evaluatedAt: new Date().toISOString(),
    } as JevAnswer;
    const evaluation = evaluateQuestionPolicies({ k: answer }, [{ questionId: spec.id, policy: policyForQuestion(spec) }]);
    assert.notEqual(evaluation.outcome, "AUTO_APPROVE", `${spec.id} cannot approve`);
  }
});

test("a question with no policy mapping is recorded as no-policy and goes to review whatever its calibrated answer", () => {
  const spec: JevQuestionSpec = {
    id: "test.unmapped.v1",
    version: "9.9.9",
    type: "noul",
    instructions: "No policy here.",
    criteria: { true: "yes", false: "no" },
    evidenceRequirements: [],
  };
  assert.equal(policyForQuestion(spec), null);
  assert.equal(policyVersionOf(spec), "test.unmapped.v1@9.9.9(no-policy)");
  const answer = {
    questionId: spec.id,
    questionVersion: spec.version,
    type: spec.type,
    model: "stub",
    provider: "stub",
    status: "answered",
    answer: 0.99,
    probability: 0.99,
    semantics: "probability",
    calibrationStatus: "calibrated",
    evidenceRefs: [],
    evaluatedAt: new Date().toISOString(),
  } as JevAnswer;
  const evaluation = evaluateQuestionPolicies({ k: answer }, [{ questionId: spec.id, policy: null }]);
  assert.equal(evaluation.outcome, "HUMAN_REVIEW");
  assert.equal(evaluation.unresolved[0]?.status, "no_policy");
});

test("a changed question version changes the recorded policy version, so an old decision can be told apart", () => {
  const base: JevQuestionSpec = {
    id: "test.versioned.v1",
    version: "1.0.0",
    type: "noul",
    instructions: "x",
    criteria: { true: "y", false: "n" },
    evidenceRequirements: [],
    policyMapping: { approveMinProbability: 0.9, reviewMinProbability: 0.6 },
  };
  assert.notEqual(policyVersionOf(base), policyVersionOf({ ...base, version: "1.0.1" }));
});
