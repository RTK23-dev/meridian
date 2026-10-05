import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_WEIGHTS, opportunityScore } from "./scoring.ts";

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
