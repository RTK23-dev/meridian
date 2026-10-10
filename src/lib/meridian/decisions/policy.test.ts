import assert from "node:assert/strict";
import test from "node:test";
import type { JevAnswer } from "../jev/types.ts";
import { CREATIVE_QA_POLICY, DECISION_POLICY_VERSION, SAFETY_GATE_POLICY, evaluateDecisionPolicy, type DecisionPolicy } from "./policy.ts";

const base = { model: "m", provider: "p", evidenceRefs: [], evaluatedAt: "2026-10-10T00:00:00.000Z", questionVersion: "1.0.0" };

function predicate(questionId: string, probability: number, calibrationStatus?: "uncalibrated" | "calibrated"): JevAnswer {
  return { ...base, questionId, type: "noul", status: "answered", noul: probability, probability, answer: probability, semantics: "probability", calibrationStatus } as JevAnswer;
}
function choice(questionId: string, value: string): JevAnswer {
  return { ...base, questionId, type: "choice", status: "answered", choice: value, answer: value, semantics: "categorical" } as JevAnswer;
}
function score(questionId: string, index: number): JevAnswer {
  return { ...base, questionId, type: "score", status: "answered", score: index, answer: index, semantics: "ordered_score" } as JevAnswer;
}
function unresolved(questionId: string, status: JevAnswer["status"]): JevAnswer {
  return { ...base, questionId, status, abstainReason: `${status}`, type: "noul" } as JevAnswer;
}
const byId = (answers: JevAnswer[]) => Object.fromEntries(answers.map((answer, index) => [`k${index}`, answer]));

test("a predicate that passes its approval threshold is an automatic approval, with the policy version recorded", () => {
  const result = evaluateDecisionPolicy(byId([predicate("q.a", 0.95)]), CREATIVE_QA_POLICY, ["q.a"]);
  assert.equal(result.outcome, "AUTO_APPROVE");
  assert.equal(result.policyVersion, CREATIVE_QA_POLICY.version);
  assert.match(DECISION_POLICY_VERSION, /^decision-policy\.v\d+$/);
});

test("a predicate between the review and approval thresholds goes to human review", () => {
  const result = evaluateDecisionPolicy(byId([predicate("q.a", 0.7)]), CREATIVE_QA_POLICY, ["q.a"]);
  assert.equal(result.outcome, "HUMAN_REVIEW");
});

test("a predicate below the review threshold is rejected under a pass-if-true policy", () => {
  const result = evaluateDecisionPolicy(byId([predicate("q.a", 0.2)]), CREATIVE_QA_POLICY, ["q.a"]);
  assert.equal(result.outcome, "REJECT");
});

test("a defect predicate is read the other way: a high probability of the defect rejects", () => {
  const policy: DecisionPolicy = { ...SAFETY_GATE_POLICY, unresolvedOutcome: "REJECT" };
  assert.equal(evaluateDecisionPolicy(byId([predicate("q.defect", 0.95)]), policy, ["q.defect"]).outcome, "REJECT");
  assert.equal(evaluateDecisionPolicy(byId([predicate("q.defect", 0.02)]), policy, ["q.defect"]).outcome, "AUTO_APPROVE");
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
  const result = evaluateDecisionPolicy(byId([predicate("q.safe", 0.99), unresolved("q.other", "refused")]), SAFETY_GATE_POLICY, ["q.safe", "q.other"]);
  assert.equal(result.outcome, "REJECT");
});

test("a rejection choice rejects, an approval choice approves, and an unlisted choice goes to review", () => {
  const policy: DecisionPolicy = { ...CREATIVE_QA_POLICY, approveChoices: ["organic_catalyst"], rejectChoices: ["bolted_on_cta"] };
  assert.equal(evaluateDecisionPolicy(byId([choice("q.c", "bolted_on_cta")]), policy, ["q.c"]).outcome, "REJECT");
  assert.equal(evaluateDecisionPolicy(byId([choice("q.c", "organic_catalyst")]), policy, ["q.c"]).outcome, "AUTO_APPROVE");
  assert.equal(evaluateDecisionPolicy(byId([choice("q.c", "ambient_presence")]), policy, ["q.c"]).outcome, "HUMAN_REVIEW");
});

test("a score without a threshold always goes to review; with one, it is compared to the minimum index", () => {
  assert.equal(evaluateDecisionPolicy(byId([score("q.s", 4)]), CREATIVE_QA_POLICY, ["q.s"]).outcome, "HUMAN_REVIEW");
  const policy: DecisionPolicy = { ...CREATIVE_QA_POLICY, approveMinScore: 3 };
  assert.equal(evaluateDecisionPolicy(byId([score("q.s", 4)]), policy, ["q.s"]).outcome, "AUTO_APPROVE");
  assert.equal(evaluateDecisionPolicy(byId([score("q.s", 1)]), policy, ["q.s"]).outcome, "HUMAN_REVIEW");
});

test("an uncalibrated probability is counted as uncalibrated, not presented as a calibrated risk", () => {
  const result = evaluateDecisionPolicy(byId([predicate("q.a", 0.95), predicate("q.b", 0.95, "calibrated")]), CREATIVE_QA_POLICY, ["q.a", "q.b"]);
  assert.equal(result.uncalibratedAnswers, 1);
  assert.equal(result.votes.find((vote) => vote.questionId === "q.a")?.calibrationStatus, "uncalibrated");
});

test("changing a threshold changes the policy version, so an old evaluation can be told apart", () => {
  const v2: DecisionPolicy = { ...CREATIVE_QA_POLICY, version: "creative-qa.v2", approveMinProbability: 0.99 };
  const under = evaluateDecisionPolicy(byId([predicate("q.a", 0.95)]), CREATIVE_QA_POLICY, ["q.a"]);
  const over = evaluateDecisionPolicy(byId([predicate("q.a", 0.95)]), v2, ["q.a"]);
  assert.equal(under.outcome, "AUTO_APPROVE");
  assert.equal(over.outcome, "HUMAN_REVIEW");
  assert.notEqual(under.policyVersion, over.policyVersion);
});
