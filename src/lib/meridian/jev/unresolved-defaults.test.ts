import assert from "node:assert/strict";
import test from "node:test";
import { decide, type DecisionContext } from "./engine.ts";
import { evaluatePolicy } from "./policy.ts";
import { brandFitQuestion, historicalSupport, opportunityGate, positioningFit, visualQa, competitiveStrength } from "./questions.ts";
import { judgeFeatures, PRIOR_JUDGMENT, QUESTION_SPECS } from "./judgment.ts";
import type { JevAnswer } from "./types.ts";

// The largest calibration offset the policy layer allows. A missing value must not be lifted into a decision band by it.
const LIFT: DecisionContext = { calibration: { version: "lift.test.v1", apply: (score: number) => score + 0.5 } };
const DROP: DecisionContext = { calibration: { version: "drop.test.v1", apply: (score: number) => score - 0.5 } };
const IDENTITY: DecisionContext = { calibration: { version: "identity.test.v1", apply: (score: number) => score } };

const vision = (overrides: Partial<Parameters<typeof visualQa.evaluate>[0]>) => ({
  available: true,
  logoPresent: null,
  logoMatchProbability: null,
  paletteMatch: null,
  productMatch: null,
  claimDetected: null,
  claimSupported: null,
  toneFit: null,
  ...overrides,
});

test("missing vision evidence is unresolved: no number is stored as a reading, and calibration cannot approve it", () => {
  const output = decide(visualQa, vision({ available: false }), LIFT);
  assert.equal(output.evidenceState, "missing");
  assert.equal(output.decision, "HUMAN_REVIEW");
  assert.equal(output.answer.value, "insufficient");
  assert.equal(output.score, 0, "the placeholder is zero, not a reading");
  assert.equal(output.confidence, 0);
});

test("vision evidence with no numeric measure is unresolved: it is not given the 0.7 default, and it cannot approve even when lifted", () => {
  const output = decide(visualQa, vision({ available: true }), LIFT);
  assert.equal(output.evidenceState, "missing");
  assert.equal(output.decision, "HUMAN_REVIEW");
  assert.equal(output.answer.value, "insufficient");
  assert.notEqual(output.score, 0.7);
  assert.equal(output.score, 0);
});

test("with a measure present, the vision score is the measure, not a default", () => {
  const output = decide(visualQa, vision({ logoMatchProbability: 0.8, paletteMatch: 0.6 }), IDENTITY);
  assert.equal(output.evidenceState, "present");
  assert.equal(output.score, 0.7);
});

test("no competitor observations is missing evidence, and a lowered calibration cannot turn it into a rejection", () => {
  const output = decide(competitiveStrength, { competitorCount: 0, matchingCompetitors: 0, ownCount: 0, matchingOwn: 0 }, DROP);
  assert.equal(output.evidenceState, "missing");
  assert.equal(output.decision, "HUMAN_REVIEW");
  assert.notEqual(output.decision, "REJECT");
  assert.equal(output.score, 0);
});

test("no learned history is missing evidence, and a lowered calibration cannot turn it into a rejection", () => {
  const output = decide(historicalSupport, { lift: null, sampleSize: 0, impressions: 0, metric: "ctr" }, DROP);
  assert.equal(output.evidenceState, "missing");
  assert.equal(output.decision, "HUMAN_REVIEW");
  assert.equal(output.score, 0);
});

test("a thin brand brain is missing evidence, and a lowered calibration cannot turn it into a rejection", () => {
  const output = decide(brandFitQuestion, { keywordHits: 0, keywordTotal: 0, formatPreferred: false, brainFilled: 0 }, DROP);
  assert.equal(output.evidenceState, "missing");
  assert.equal(output.decision, "HUMAN_REVIEW");
  assert.notEqual(output.decision, "REJECT");
});

test("a blank positioning is missing evidence, not a zero overlap that reads as a measured fit", () => {
  const output = decide(positioningFit, { overlap: 0, avoidedWordHits: [], brainHasPositioning: false }, LIFT);
  assert.equal(output.evidenceState, "missing");
  assert.equal(output.decision, "HUMAN_REVIEW");
  assert.equal(output.score, 0);
});

test("an opportunity with a missing component is unresolved: review, not rejection, under a lowered calibration", () => {
  const output = decide(
    opportunityGate,
    {
      competitive: { competitorCount: 0, matchingCompetitors: 0, ownCount: 0, matchingOwn: 0 },
      brand: { keywordHits: 0, keywordTotal: 0, formatPreferred: false, brainFilled: 0 },
      historical: { lift: null, sampleSize: 0, impressions: 0, metric: "ctr" },
      risk: { claimIntensity: 0, aggressiveRejections: 0, negativeLift: 0 },
      reproducibility: { templateCoverage: 0.9, copiesProtectedPhrasing: false },
    },
    DROP,
  );
  assert.equal(output.evidenceState, "missing");
  assert.equal(output.decision, "HUMAN_REVIEW");
  assert.notEqual(output.decision, "REJECT");
});

test("an opportunity whose parts are all measured still scores from the measures", () => {
  const output = decide(
    opportunityGate,
    {
      competitive: { competitorCount: 4, matchingCompetitors: 1, ownCount: 2, matchingOwn: 0 },
      brand: { keywordHits: 4, keywordTotal: 5, formatPreferred: true, brainFilled: 0.9 },
      historical: { lift: 0.4, sampleSize: 6, impressions: 9000, metric: "ctr" },
      risk: { claimIntensity: 0.1, aggressiveRejections: 0, negativeLift: 0 },
      reproducibility: { templateCoverage: 0.9, copiesProtectedPhrasing: false },
    },
    IDENTITY,
  );
  assert.notEqual(output.evidenceState, "missing");
  assert.ok(output.score > 0);
});

test("the legacy policy does not invent a probability: booleans alone cannot approve", () => {
  const answered = (key: string, answer: boolean): JevAnswer => ({
    questionId: key,
    questionVersion: "1.0.0",
    type: "noul",
    model: "stub",
    provider: "stub",
    status: "answered",
    answer,
    evidenceRefs: [],
    evaluatedAt: new Date().toISOString(),
  });
  const evaluation = evaluatePolicy({ a: answered("unmapped.a", true), b: answered("unmapped.b", true) });
  assert.equal(evaluation.decision, "HUMAN_REVIEW");
  assert.notEqual(evaluation.decision, "AUTO_APPROVE");
  assert.match(evaluation.reason, /No probability was returned/);
});

test("a judgment with no evidence has no reading: the probability is zero and nothing is clamped into the review band", () => {
  const spec = QUESTION_SPECS.find((entry) => entry.id === "brand_fit")!;
  const output = judgeFeatures(spec, [{ name: "aligned", value: 0.9, evidenceId: "e", source: "s", summary: "x" }], PRIOR_JUDGMENT, false);
  assert.equal(output.evidenceState, "missing");
  assert.equal(output.decision, "HUMAN_REVIEW");
  assert.equal(output.probability, 0);
  assert.equal(output.confidence, 0);
});
