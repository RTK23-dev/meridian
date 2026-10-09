import assert from "node:assert/strict";
import test from "node:test";
import { isSyntheticOrTestRecord, assertLearnableRecord } from "./guardrails.ts";
import { assessAngleFatigue } from "./fatigue.ts";

test("guardrails detect and block synthetic test data from learning", () => {
  const fixture = { id: "fixture-creative-123", name: "Fixture Video" };
  const mock = { id: "ad-1", provider: "timeline" };
  const synthetic = { id: "ad-2", isSynthetic: true };
  const real = { id: "ad-real-999", name: "Live Production Ad", provider: "meta" };

  assert.equal(isSyntheticOrTestRecord(fixture), true);
  assert.equal(isSyntheticOrTestRecord(mock), true);
  assert.equal(isSyntheticOrTestRecord(synthetic), true);
  assert.equal(isSyntheticOrTestRecord(real), false);

  assert.throws(() => assertLearnableRecord(fixture), /cannot be ingested into production learning/);
  assert.doesNotThrow(() => assertLearnableRecord(real));
});

test("assessAngleFatigue recommends pause when impressions and fatigue are saturated", () => {
  const assessment = assessAngleFatigue({
    angle: "unboxing_surprise",
    totalImpressions: 800_000,
    activeAdCount: 15,
    recentCtrChangePercent: -35,
    daysActive: 90,
  });

  assert.equal(assessment.status, "EXHAUSTED");
  assert.equal(assessment.recommendedAction, "PAUSE");
  assert.ok(assessment.fatigueScore >= 0.75);
});

test("assessAngleFatigue recommends scale for fresh angles", () => {
  const assessment = assessAngleFatigue({
    angle: "new_contrast_hook",
    totalImpressions: 15_000,
    activeAdCount: 2,
    recentCtrChangePercent: 5,
    daysActive: 7,
  });

  assert.equal(assessment.status, "FRESH");
  assert.equal(assessment.recommendedAction, "SCALE");
  assert.ok(assessment.fatigueScore < 0.25);
});
