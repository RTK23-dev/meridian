import assert from "node:assert/strict";
import { test } from "node:test";
import { decisionCapFor, starterLimitPlan } from "./starter.ts";

const ranges = { measure: { min: 0.01, max: 5 }, decision: { min: 0.01, max: 5 } };
const brand = (brandId: string, brandBudgetUsd: number | null) => ({ brandId, name: brandId, brandBudgetUsd, committedUsd: 0, factoryDailyCapUsd: null, factoryTotalCapUsd: null });
const workspace = (over: Partial<{ monthlyBudgetUsd: number | null; decisionCapUsd: number | null; policyReadable: boolean }> = {}) => ({
  monthlyBudgetUsd: null, measureCeilingUsdPerSecond: null, decisionCapUsd: null, policyReadable: true, policyReason: null, ...over,
});

test("a fresh workspace gets the monthly budget, each brand's budget and a decision cap", () => {
  const plan = starterLimitPlan({ workspace: workspace(), brands: [brand("a", null), brand("b", null)], ranges }, 10);
  assert.deepEqual(plan.steps.map((s) => [s.kind, s.brandId, s.value]), [
    ["workspace_monthly_budget", null, 10],
    ["brand_budget", "a", 10],
    ["brand_budget", "b", 10],
    ["decision_cap", null, 0.2],
  ]);
});

test("a limit that is already set is never part of the plan", () => {
  const plan = starterLimitPlan({ workspace: workspace({ monthlyBudgetUsd: 50, decisionCapUsd: 0.05 }), brands: [brand("a", 5), brand("b", null)], ranges }, 10);
  assert.deepEqual(plan.steps.map((s) => [s.kind, s.brandId, s.value]), [["brand_budget", "b", 10]]);
});

test("an unreadable policy is not written over, and the decision cap stays inside its range", () => {
  assert.equal(starterLimitPlan({ workspace: workspace({ policyReadable: false }), brands: [], ranges }, 10).steps.some((s) => s.kind === "decision_cap"), false);
  assert.equal(decisionCapFor(1, ranges.decision), 0.02);
  assert.equal(decisionCapFor(100000, ranges.decision), 5);
  assert.equal(decisionCapFor(0.1, ranges.decision), 0.01);
});
