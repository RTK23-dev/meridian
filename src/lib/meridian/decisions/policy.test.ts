import assert from "node:assert/strict";
import test from "node:test";
import type { JevAnswer, JevQuestionSpec } from "../jev/types.ts";
import {
  CREATIVE_QA_POLICY,
  DECISION_POLICY_VERSION,
  SAFETY_GATE_POLICY,
  evaluateDecisionPolicy,
  evaluateQuestionPolicies,
  policyForQuestion,
  policyVersionOf,
  type DecisionPolicy,
} from "./policy.ts";

const base = { model: "m", provider: "p", evidenceRefs: [], evaluatedAt: "2026-10-10T00:00:00.000Z", questionVersion: "1.0.0" };

function predicate(questionId: string, probability: number, calibrationStatus?: "uncalibrated" | "calibrated"): JevAnswer {
  return { ...base, questionId, type: "noul", status: "answered", noul: probability, probability, answer: probability, semantics: "probability", calibrationStatus } as JevAnswer;
}
function choice(questionId: string, value: string): JevAnswer {
  return { ...base, questionId, type: "choice", status: "answered", choice: value, answer: value, semantics: "categorical" } as JevAnswer;
}
function score(questionId: string, index: number, calibrationStatus?: "uncalibrated" | "calibrated"): JevAnswer {
  return { ...base, questionId, type: "score", status: "answered", score: index, answer: index, semantics: "ordered_score", calibrationStatus } as JevAnswer;
}
function unresolved(questionId: string, status: JevAnswer["status"]): JevAnswer {
  return { ...base, questionId, status, abstainReason: `${status}`, type: "noul" } as JevAnswer;
}
const byId = (answers: JevAnswer[]) => Object.fromEntries(answers.map((answer, index) => [`k${index}`, answer]));

test("a calibrated probability that passes its approval threshold is an automatic approval, with the policy version recorded", () => {
  const result = evaluateDecisionPolicy(byId([predicate("q.a", 0.95, "calibrated")]), CREATIVE_QA_POLICY, ["q.a"]);
  assert.equal(result.outcome, "AUTO_APPROVE");
  assert.equal(result.policyVersion, CREATIVE_QA_POLICY.version);
  assert.match(DECISION_POLICY_VERSION, /^decision-policy\.v\d+$/);
});

test("a predicate between the review and approval thresholds goes to human review", () => {
  const result = evaluateDecisionPolicy(byId([predicate("q.a", 0.7)]), CREATIVE_QA_POLICY, ["q.a"]);
  assert.equal(result.outcome, "HUMAN_REVIEW");
});

test("a calibrated predicate below the review threshold is rejected under a pass-if-true policy", () => {
  const result = evaluateDecisionPolicy(byId([predicate("q.a", 0.2, "calibrated")]), CREATIVE_QA_POLICY, ["q.a"]);
  assert.equal(result.outcome, "REJECT");
});

test("a calibrated defect predicate is read the other way: a high probability of the defect rejects", () => {
  const policy: DecisionPolicy = { ...SAFETY_GATE_POLICY, unresolvedOutcome: "REJECT" };
  assert.equal(evaluateDecisionPolicy(byId([predicate("q.defect", 0.95, "calibrated")]), policy, ["q.defect"]).outcome, "REJECT");
  assert.equal(evaluateDecisionPolicy(byId([predicate("q.defect", 0.02, "calibrated")]), policy, ["q.defect"]).outcome, "AUTO_APPROVE");
});

test("a refused, unsupported, malformed, or missing answer is never an approval", () => {
  for (const status of ["refused", "unsupported", "invalid_response", "provider_error"] as const) {
    const result = evaluateDecisionPolicy(byId([unresolved("q.a", status)]), CREATIVE_QA_POLICY, ["q.a"]);
    assert.notEqual(result.outcome, "AUTO_APPROVE", `${status} must not approve`);
    assert.equal(result.outcome, "HUMAN_REVIEW", "the default unresolved outcome is human review");
  }
  const missing = evaluateDecisionPolicy({}, CREATIVE_QA_POLICY, ["q.absent"]);
  assert.equal(missing.outcome, "HUMAN_REVIEW");
  assert.equal(missing.unresolved[0].status, "missing");
});

test("a safety-critical gate fails closed: an unresolved required answer rejects", () => {
  const result = evaluateDecisionPolicy(byId([predicate("q.safe", 0.99, "calibrated"), unresolved("q.other", "refused")]), SAFETY_GATE_POLICY, ["q.safe", "q.other"]);
  assert.equal(result.outcome, "REJECT");
});

test("a rejection choice rejects, an approval choice approves, and an unlisted choice goes to review", () => {
  const policy: DecisionPolicy = { ...CREATIVE_QA_POLICY, approveChoices: ["organic_catalyst"], rejectChoices: ["bolted_on_cta"] };
  assert.equal(evaluateDecisionPolicy(byId([choice("q.c", "bolted_on_cta")]), policy, ["q.c"]).outcome, "REJECT");
  assert.equal(evaluateDecisionPolicy(byId([choice("q.c", "organic_catalyst")]), policy, ["q.c"]).outcome, "AUTO_APPROVE");
  assert.equal(evaluateDecisionPolicy(byId([choice("q.c", "ambient_presence")]), policy, ["q.c"]).outcome, "HUMAN_REVIEW");
});

test("a score without a threshold always goes to review; a calibrated score is compared to the minimum index", () => {
  assert.equal(evaluateDecisionPolicy(byId([score("q.s", 4, "calibrated")]), CREATIVE_QA_POLICY, ["q.s"]).outcome, "HUMAN_REVIEW");
  const policy: DecisionPolicy = { ...CREATIVE_QA_POLICY, approveMinScore: 3 };
  assert.equal(evaluateDecisionPolicy(byId([score("q.s", 4, "calibrated")]), policy, ["q.s"]).outcome, "AUTO_APPROVE");
  assert.equal(evaluateDecisionPolicy(byId([score("q.s", 1, "calibrated")]), policy, ["q.s"]).outcome, "HUMAN_REVIEW");
});

test("an uncalibrated probability is counted as uncalibrated, not presented as a calibrated risk", () => {
  const result = evaluateDecisionPolicy(byId([predicate("q.a", 0.95), predicate("q.b", 0.95, "calibrated")]), CREATIVE_QA_POLICY, ["q.a", "q.b"]);
  assert.equal(result.uncalibratedAnswers, 1);
  assert.equal(result.votes.find((vote) => vote.questionId === "q.a")?.calibrationStatus, "uncalibrated");
});

test("changing a threshold changes the policy version, so an old evaluation can be told apart", () => {
  const v2: DecisionPolicy = { ...CREATIVE_QA_POLICY, version: "creative-qa.v2", approveMinProbability: 0.99 };
  const under = evaluateDecisionPolicy(byId([predicate("q.a", 0.95, "calibrated")]), CREATIVE_QA_POLICY, ["q.a"]);
  const over = evaluateDecisionPolicy(byId([predicate("q.a", 0.95, "calibrated")]), v2, ["q.a"]);
  assert.equal(under.outcome, "AUTO_APPROVE");
  assert.equal(over.outcome, "HUMAN_REVIEW");
  assert.notEqual(under.policyVersion, over.policyVersion);
});

// Calibration. A probability or score that is not calibrated can route to review, and nothing else.

test("calibration: the same uncalibrated probability above the approval threshold yields review, and calibrated it approves", () => {
  const uncalibrated = evaluateDecisionPolicy(byId([predicate("q.a", 0.97)]), CREATIVE_QA_POLICY, ["q.a"]);
  assert.equal(uncalibrated.outcome, "HUMAN_REVIEW", "an uncalibrated probability is never an approval");
  assert.equal(uncalibrated.votes[0]?.calibrationStatus, "uncalibrated");
  assert.match(uncalibrated.votes[0]?.reason ?? "", /uncalibrated/);
  const calibrated = evaluateDecisionPolicy(byId([predicate("q.a", 0.97, "calibrated")]), CREATIVE_QA_POLICY, ["q.a"]);
  assert.equal(calibrated.outcome, "AUTO_APPROVE");
});

test("calibration: an uncalibrated probability never rejects, even far below the review threshold", () => {
  const result = evaluateDecisionPolicy(byId([predicate("q.a", 0.05)]), CREATIVE_QA_POLICY, ["q.a"]);
  assert.equal(result.outcome, "HUMAN_REVIEW");
});

test("calibration: an uncalibrated defect probability never rejects, however high", () => {
  const policy: DecisionPolicy = { ...SAFETY_GATE_POLICY, unresolvedOutcome: "REJECT" };
  assert.equal(evaluateDecisionPolicy(byId([predicate("q.defect", 0.99)]), policy, ["q.defect"]).outcome, "HUMAN_REVIEW");
});

test("calibration: an uncalibrated score meeting its minimum yields review, and a calibrated one approves", () => {
  const policy: DecisionPolicy = { ...CREATIVE_QA_POLICY, approveMinScore: 3 };
  assert.equal(evaluateDecisionPolicy(byId([score("q.s", 5)]), policy, ["q.s"]).outcome, "HUMAN_REVIEW");
  assert.equal(evaluateDecisionPolicy(byId([score("q.s", 5, "calibrated")]), policy, ["q.s"]).outcome, "AUTO_APPROVE");
});

test("missing threshold: a probability with no approveMinProbability cannot approve, even when calibrated", () => {
  const policy: DecisionPolicy = { ...CREATIVE_QA_POLICY, approveMinProbability: undefined };
  const result = evaluateDecisionPolicy(byId([predicate("q.a", 0.99, "calibrated")]), policy, ["q.a"]);
  assert.equal(result.outcome, "HUMAN_REVIEW");
  assert.match(result.votes[0]?.reason ?? "", /no approveMinProbability/);
});

test("missing threshold: a choice with no approve values cannot approve", () => {
  const result = evaluateDecisionPolicy(byId([choice("q.c", "organic_catalyst")]), CREATIVE_QA_POLICY, ["q.c"]);
  assert.equal(result.outcome, "HUMAN_REVIEW");
});

test("regression: a previously approving question becomes review when its approveMinProbability mapping is dropped", () => {
  const mapped: Pick<JevQuestionSpec, "id" | "version" | "policyMapping"> = {
    id: "q.regression",
    version: "1.0.0",
    policyMapping: { predicateDirection: "pass_if_true", approveMinProbability: 0.85, reviewMinProbability: 0.6 },
  };
  const dropped: Pick<JevQuestionSpec, "id" | "version" | "policyMapping"> = {
    id: "q.regression",
    version: "1.0.0",
    policyMapping: { predicateDirection: "pass_if_true", reviewMinProbability: 0.6 },
  };
  const answers = byId([predicate("q.regression", 0.97, "calibrated")]);
  const before = evaluateQuestionPolicies(answers, [{ questionId: "q.regression", policy: policyForQuestion(mapped) }]);
  assert.equal(before.outcome, "AUTO_APPROVE", "with the mapping, the calibrated answer approves");
  const after = evaluateQuestionPolicies(answers, [{ questionId: "q.regression", policy: policyForQuestion(dropped) }]);
  assert.equal(after.outcome, "HUMAN_REVIEW", "without the mapping, the same answer can only go to review");
});

test("missing policy: a question with no policy mapping is reviewed whatever its calibrated answer", () => {
  const unmapped: Pick<JevQuestionSpec, "id" | "version" | "policyMapping"> = { id: "q.unmapped", version: "1.0.0" };
  assert.equal(policyForQuestion(unmapped), null);
  assert.equal(policyVersionOf(unmapped), "q.unmapped@1.0.0(no-policy)");
  const result = evaluateQuestionPolicies(byId([predicate("q.unmapped", 0.999, "calibrated")]), [{ questionId: "q.unmapped", policy: null }]);
  assert.equal(result.outcome, "HUMAN_REVIEW");
  assert.equal(result.unresolved[0]?.status, "no_policy");
});

test("scope: an approving answer whose evidence scope held no evidence cannot approve", () => {
  const result = evaluateQuestionPolicies(byId([predicate("q.a", 0.99, "calibrated")]), [
    { questionId: "q.a", policy: CREATIVE_QA_POLICY, scopePresent: false },
  ]);
  assert.equal(result.outcome, "HUMAN_REVIEW");
  assert.equal(result.unresolved[0]?.status, "abstain_insufficient_evidence");
});

test("AUTO_APPROVE needs every gating question approved: one unresolved question blocks the others", () => {
  const result = evaluateQuestionPolicies(byId([predicate("q.a", 0.99, "calibrated"), unresolved("q.b", "refused")]), [
    { questionId: "q.a", policy: CREATIVE_QA_POLICY },
    { questionId: "q.b", policy: CREATIVE_QA_POLICY },
  ]);
  assert.equal(result.outcome, "HUMAN_REVIEW");
});
