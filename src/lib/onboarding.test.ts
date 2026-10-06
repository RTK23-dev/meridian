import assert from "node:assert/strict";
import test from "node:test";
import { getOnboardingSteps } from "./onboarding.ts";

test("onboarding marks only recorded milestones complete", () => {
  const steps = getOnboardingSteps({
    brands: [{ id: "brand-a", completeness: 0.5, competitors: 0, opportunities: 1, creatives: 0 }],
    providerConnected: false,
    reviewedCreative: false,
  });
  assert.deepEqual(steps.map((step) => step.done), [true, false, false, false, true, false, false]);
  assert.equal(steps[3]?.to, "/brands/brand-a/market");
});

test("an empty workspace points setup actions to brand creation", () => {
  const steps = getOnboardingSteps({ brands: [], providerConnected: false, reviewedCreative: false });
  assert.ok(steps.slice(1).every((step) => step.to === "/brands/new" || step.to === "/integrations"));
  assert.ok(steps.every((step) => !step.done));
});
