import assert from "node:assert/strict";
import test from "node:test";
import { ANSWER_SCHEMA_VERSION } from "../jev/engine.ts";
import { creativeJudgmentsFromStoredDecision } from "./jev-context.ts";

const base = {
  id: "decision-1",
  subjectType: "brief",
  questionId: "brief_completeness",
  questionVersion: "brief-completeness.v1",
  schemaVersion: ANSWER_SCHEMA_VERSION,
  decision: "AUTO_APPROVE",
  answer: JSON.stringify({
    schemaVersion: ANSWER_SCHEMA_VERSION,
    value: "yes",
    score: 0.91,
    probability: 0.91,
    confidence: 0.82,
  }),
  modelResponse: "",
  evidence: JSON.stringify([{ id: "brief-fields", source: "briefs", summary: "5 of 5 fields stored" }]),
  provider: "logistic-prior",
  model: "v1",
};

test("valid deterministic brief gate is admissible without inventing strategic recommendations", () => {
  const bundle = creativeJudgmentsFromStoredDecision(base);
  assert.equal(bundle.status, "admissible");
  assert.deepEqual(bundle.recommendedFormats, []);
  assert.deepEqual(bundle.evidenceRefs, ["brief-fields"]);
});

test("malformed or wrong-question stored records remain inadmissible", () => {
  assert.equal(creativeJudgmentsFromStoredDecision({ ...base, answer: "{}" }).status, "abstain_malformed");
  assert.equal(creativeJudgmentsFromStoredDecision({ ...base, questionId: "creative_quality" }).status, "abstain_malformed");
  assert.equal(creativeJudgmentsFromStoredDecision({ ...base, schemaVersion: "unknown" }).status, "abstain_malformed");
});

test("a persisted negative brief answer blocks creative production", () => {
  const answer = JSON.stringify({
    schemaVersion: ANSWER_SCHEMA_VERSION,
    value: "no",
    score: 0.1,
    probability: 0.1,
    confidence: 0.9,
  });
  assert.equal(creativeJudgmentsFromStoredDecision({ ...base, answer, decision: "HUMAN_REVIEW" }).status, "abstain_rejected");
});

test("schema-valid strategic model response preserves its explicit recommendation", () => {
  const bundle = creativeJudgmentsFromStoredDecision({
    ...base,
    subjectType: "opportunity",
    questionId: "creative_direction",
    schemaVersion: "creative-judgment.v1",
    modelResponse: JSON.stringify({
      decision: "APPROVE",
      creativeMechanism: "Show lather as proof",
      recommendedFormats: [{ format: "image", rationale: "Static proof is sufficient", priority: 1 }],
      formatSuitability: { image: { suitable: true, rationale: "Proof is visible" } },
      evidenceRefs: ["ad-1"],
    }),
  });
  assert.equal(bundle.status, "admissible");
  assert.equal(bundle.recommendedFormats[0]?.format, "image");
  assert.equal(bundle.creativeMechanism, "Show lather as proof");
});
