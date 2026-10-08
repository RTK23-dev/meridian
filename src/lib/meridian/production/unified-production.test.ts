import assert from "node:assert/strict";
import test from "node:test";
import { productionRouter } from "./router.ts";
import { evaluateProductionPreflight } from "./preflight.ts";
import { evaluateProductionPostflight } from "./postflight.ts";
import type { CreativeSpec, ProductionJob } from "./types.ts";

test("productionRouter selects manual_cloud in ZERO_SPEND mode", () => {
  const spec: CreativeSpec = {
    id: "spec-1",
    organizationId: "org-1",
    brandId: "brand-1",
    title: "Test Creative",
    format: "ugc",
    aspectRatio: "9:16",
    durationTargetSeconds: 30,
    hookLine: "Stop scrolling!",
    script: "Here is why this works.",
    scenes: [],
  };

  const provider = productionRouter.route(spec, "ZERO_SPEND");
  assert.equal(provider.id, "manual_cloud");
  assert.equal(provider.capabilities.zeroSpend, true);
});

test("evaluateProductionPreflight blocks specs with missing required elements", () => {
  const invalidSpec: CreativeSpec = {
    id: "spec-invalid",
    organizationId: "org-1",
    brandId: "brand-1",
    title: "Empty Spec",
    format: "ugc",
    aspectRatio: "9:16",
    durationTargetSeconds: 0,
    hookLine: "",
    script: "",
    scenes: [],
  };

  const preflight = evaluateProductionPreflight(invalidSpec);
  assert.equal(preflight.passed, false);
  assert.equal(preflight.decision, "BLOCK");
  assert.ok(preflight.reasons.length >= 2);
});

test("evaluateProductionPreflight approves valid specs", () => {
  const validSpec: CreativeSpec = {
    id: "spec-valid",
    organizationId: "org-1",
    brandId: "brand-1",
    title: "Complete Spec",
    format: "ugc",
    aspectRatio: "9:16",
    durationTargetSeconds: 25,
    hookLine: "Watch what happened after 7 days.",
    script: "I thought my skin was doomed, but then I found this.",
    scenes: [
      { index: 0, description: "Holding up product", durationSeconds: 5 },
      { index: 1, description: "Applying on face", durationSeconds: 20 },
    ],
  };

  const preflight = evaluateProductionPreflight(validSpec);
  assert.equal(preflight.passed, true);
  assert.equal(preflight.decision, "PROCEED");
});

test("evaluateProductionPostflight rejects empty byte artifacts", () => {
  const job: ProductionJob = {
    jobId: "job-1",
    organizationId: "org-1",
    brandId: "brand-1",
    creativeSpec: {
      id: "spec-1",
      organizationId: "org-1",
      brandId: "brand-1",
      title: "Test",
      format: "ugc",
      aspectRatio: "9:16",
      durationTargetSeconds: 15,
      hookLine: "Hook",
      script: "Script",
      scenes: [],
    },
    providerId: "manual_cloud",
    status: "RENDERED",
    costEstimateUsd: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const postflight = evaluateProductionPostflight({
    job,
    videoBytes: new Uint8Array(),
  });
  assert.equal(postflight.passed, false);
  assert.equal(postflight.decision, "REJECT_DEFECTIVE");
});
