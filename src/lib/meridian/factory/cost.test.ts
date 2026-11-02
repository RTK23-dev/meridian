// The stage-cost rollup (B12, Q27): a row with no price is counted as unpriced, never as zero; a stage with only unpriced rows is left out
// of the stages; the totals are the priced sums. Read only: nothing here checks a budget.

import assert from "node:assert/strict";
import { test } from "node:test";
import { rollupCosts, stageRollupOf } from "./cost.ts";

test("priced rows sum by stage, unpriced rows are counted and never read as zero", () => {
  const rollup = stageRollupOf([
    { stage: "render", cents: 120, seconds: 30 },
    { stage: "render", cents: 80, seconds: 20 },
    { stage: "script", cents: null, seconds: 5 },
    { stage: "voice", cents: 40, seconds: 10 },
  ]);
  assert.deepEqual(rollup.stages, [
    { stage: "render", cents: 200, seconds: 50 },
    { stage: "voice", cents: 40, seconds: 10 },
  ]);
  assert.equal(rollup.unpricedRows, 1);
});

test("a stage with only unpriced rows is not listed, so no total shows as zero", () => {
  const rollup = stageRollupOf([{ stage: "script", cents: null, seconds: 5 }]);
  assert.deepEqual(rollup.stages, []);
  assert.equal(rollup.unpricedRows, 1);
});

test("the cost per variant is null when no variant is counted, and the priced total is the sum of the stages", () => {
  const rollup = stageRollupOf([{ stage: "render", cents: 200, seconds: 50 }]);
  const none = rollupCosts({ stages: rollup.stages, decodedAds: 0, variants: 0, winningVariants: 0 });
  assert.equal(none.totalCents, 200);
  assert.equal(none.costPerVariantCents, null);
  const some = rollupCosts({ stages: rollup.stages, decodedAds: 0, variants: 4, winningVariants: 0 });
  assert.equal(some.costPerVariantCents, 50);
});
