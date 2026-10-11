import assert from "node:assert/strict";
import test from "node:test";
import { getOnboardingSteps } from "./onboarding.ts";

test("onboarding marks only recorded milestones complete", () => {
  const steps = getOnboardingSteps({
    brands: [{ id: "brand-a", completeness: 0.5, requiredComplete: false, competitors: 0, opportunities: 1, creatives: 0 }],
    providerConnected: false,
    reviewedCreative: false,
  });
  assert.deepEqual(steps.map((step) => step.done), [true, false, false, false, true, false, false]);
  assert.equal(steps[3]?.to, "/brands/brand-a/market");
});

test("the brain step is done only when a brand has every required field, read from requiredComplete", () => {
  const brainStep = (brands: { completeness: number; requiredComplete: boolean }[]) => getOnboardingSteps({
    brands: brands.map((brand, index) => ({ id: `brand-${index}`, ...brand, competitors: 0, opportunities: 0, creatives: 0 })),
    providerConnected: false,
    reviewedCreative: false,
  })[1];
  assert.equal(brainStep([{ completeness: 0.5, requiredComplete: false }])?.done, false, "two of the four required fields");
  assert.equal(brainStep([{ completeness: 0.75, requiredComplete: false }])?.done, false, "three of the four required fields");
  assert.equal(brainStep([{ completeness: 1, requiredComplete: true }])?.done, true, "all four required fields");
  assert.equal(brainStep([{ completeness: 1, requiredComplete: true }])?.to, "/brands/brand-0/brain");
  assert.equal(brainStep([{ completeness: 0.5, requiredComplete: false }, { completeness: 1, requiredComplete: true }])?.done, true, "one complete brand is enough");
});

test("the brain step ignores the ratio, so a ratio of 1 alone does not complete it", () => {
  const step = getOnboardingSteps({
    brands: [{ id: "brand-a", completeness: 1, requiredComplete: false, competitors: 0, opportunities: 0, creatives: 0 }],
    providerConnected: false,
    reviewedCreative: false,
  })[1];
  assert.equal(step?.done, false);
  assert.equal(step?.state, "todo");
});

test("an empty workspace points setup actions to brand creation", () => {
  const steps = getOnboardingSteps({ brands: [], providerConnected: false, reviewedCreative: false });
  assert.ok(steps.slice(1).every((step) => step.to === "/brands/new" || step.to === "/integrations"));
  assert.ok(steps.every((step) => !step.done));
});
