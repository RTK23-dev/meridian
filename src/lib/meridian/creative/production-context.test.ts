import assert from "node:assert/strict";
import test from "node:test";
import { CreativeDecisionEngine } from "./engine.ts";
import { TEST_PLAN_LINEAGE } from "../testing/plan-lineage.ts";

const brief = {
  title: "Sleep Calm Gummies",
  hook: "Tired of waking up at 3 AM?",
  message: "Natural magnesium and L-theanine formula for deep rest.",
  cta: "Try Sleep Calm with a 30-day money-back guarantee.",
  targetDurationSeconds: 8,
};

test("a plan records the production context it was made from, so production never needs the brief", () => {
  const productionContext = {
    title: "Sleep Calm Gummies",
    audience: "Adults who wake at night",
    angle: "problem_solution",
    productName: "Sleep Calm",
    opportunityId: "opp-1",
  };
  const plan = CreativeDecisionEngine.createPlan({
    lineage: TEST_PLAN_LINEAGE,
    scope: "video_only",
    autonomy: "semi_automatic",
    brief,
    productionContext,
  });
  assert.deepEqual(plan.productionContext, productionContext);
});

test("a plan made without a production context records none, so it can never be executed on guessed inputs", () => {
  const plan = CreativeDecisionEngine.createPlan({
    lineage: TEST_PLAN_LINEAGE,
    scope: "video_only",
    autonomy: "semi_automatic",
    brief,
  });
  assert.equal(plan.productionContext, null);
});
