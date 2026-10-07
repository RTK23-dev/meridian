import assert from "node:assert/strict";
import test from "node:test";
import { baselinePrior, bhQValues, jeffreysPrior, probabilityGreater, updateBeta } from "./beta.ts";

test("a clearly better bucket has a high chance of beating the baseline", () => {
  const prior = jeffreysPrior();
  const bucket = updateBeta(prior, 80, 1000);
  const baseline = updateBeta(prior, 40, 1000);
  assert.ok(probabilityGreater(bucket, baseline) > 0.95);
  assert.ok(probabilityGreater(baseline, bucket) < 0.05);
});

test("identical posteriors sit at one half", () => {
  const prior = baselinePrior(0.05);
  const a = updateBeta(prior, 10, 200);
  const b = updateBeta(prior, 10, 200);
  assert.ok(Math.abs(probabilityGreater(a, b) - 0.5) < 0.02);
});

test("BH keeps a strong p-value and lifts a cluster of moderate ones", () => {
  const q = bhQValues([0.001, 0.02, 0.04, 0.8]);
  assert.ok(q[0] < 0.01);
  assert.ok(q[3] > 0.2);
  assert.equal(bhQValues([]).length, 0);
});
