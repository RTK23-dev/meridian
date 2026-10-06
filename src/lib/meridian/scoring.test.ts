import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_WEIGHTS, opportunityScore, parseCount, parseWeight } from "./scoring.ts";

test("a fully supported low-risk idea outranks a saturated risky one", () => {
  const strong = opportunityScore(
    {
      brandFit: 1,
      historicalEvidence: 1,
      marketSignal: 1,
      novelty: 1,
      reproducibility: 1,
      saturation: 0,
      risk: 0,
    },
    DEFAULT_WEIGHTS,
  );
  const weak = opportunityScore(
    {
      brandFit: 0.2,
      historicalEvidence: 0,
      marketSignal: 0.2,
      novelty: 0,
      reproducibility: 0.2,
      saturation: 1,
      risk: 1,
    },
    DEFAULT_WEIGHTS,
  );
  assert.ok(strong.normalized > weak.normalized);
  assert.ok(strong.raw > 0);
  assert.ok(weak.raw < 0);
});

test("saturation and risk reduce the raw score", () => {
  const base = {
    brandFit: 0.8,
    historicalEvidence: 0.5,
    marketSignal: 0.4,
    novelty: 0.6,
    reproducibility: 0.7,
    saturation: 0,
    risk: 0,
  };
  const plain = opportunityScore(base, DEFAULT_WEIGHTS);
  const penalized = opportunityScore({ ...base, saturation: 1, risk: 1 }, DEFAULT_WEIGHTS);
  assert.ok(penalized.raw < plain.raw);
});

test("inputs outside 0–1 are clamped rather than trusted", () => {
  const scored = opportunityScore(
    {
      brandFit: 4,
      historicalEvidence: -2,
      marketSignal: 0,
      novelty: 0,
      reproducibility: 0,
      saturation: 9,
      risk: 0,
    },
    { ...DEFAULT_WEIGHTS, brandFit: 1, historicalEvidence: 1, saturation: 1, marketSignal: 0, novelty: 0, reproducibility: 0, risk: 0 },
  );
  assert.equal(scored.raw, 0);
});

test("weight parsing does not turn a blank or a scroll-cleared field into zero", () => {
  assert.equal(Number(""), 0);
  assert.equal(parseWeight("0.25", "Brand fit"), 0.25);
  assert.equal(parseWeight(0, "Brand fit"), 0);
  assert.equal(parseWeight("5", "Risk"), 5);
  assert.throws(() => parseWeight("", "Brand fit"), /Brand fit must be a number from 0 to 5/);
  assert.throws(() => parseWeight("undefined", "Brand fit"), /must be a number from 0 to 5/);
  assert.throws(() => parseWeight(".", "Brand fit"), /must be a number from 0 to 5/);
  assert.throws(() => parseWeight("1e2", "Brand fit"), /must be a number from 0 to 5/);
  assert.equal(parseCount("", "Reach", true), 0);
  assert.throws(() => parseCount("", "Impressions"), /Impressions must be a whole number/);
  assert.equal(parseCount("400", "Impressions"), 400);
});
