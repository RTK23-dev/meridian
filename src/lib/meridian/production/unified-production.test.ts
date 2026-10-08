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

test("VeoProvider returns NOT_CONFIGURED and no job id without API key", async () => {
  const originalKey = process.env.GEMINI_API_KEY;
  const originalGoogleKey = process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;

  try {
    const { VeoProvider } = await import("./providers/veo.ts");
    const provider = new VeoProvider();
    const health = await provider.health();
    assert.equal(health.state, "NOT_CONFIGURED");

    const job = await provider.submitJob({
      id: "spec-veo",
      organizationId: "org-1",
      brandId: "brand-1",
      title: "Veo Test",
      format: "ai_video",
      aspectRatio: "9:16",
      durationTargetSeconds: 5,
      hookLine: "AI Hook",
      script: "AI Script",
      scenes: [],
    });

    assert.equal(job.status, "NOT_CONFIGURED");
    assert.equal(job.jobId, "");
    assert.ok(job.error?.includes("not configured"));
  } finally {
    if (originalKey) process.env.GEMINI_API_KEY = originalKey;
    if (originalGoogleKey) process.env.GOOGLE_API_KEY = originalGoogleKey;
  }
});

test("HiggsfieldProvider returns NOT_CONFIGURED and no job id without API key", async () => {
  const originalKey = process.env.HIGGSFIELD_API_KEY;
  delete process.env.HIGGSFIELD_API_KEY;

  try {
    const { HiggsfieldProvider } = await import("./providers/higgsfield.ts");
    const provider = new HiggsfieldProvider();
    const health = await provider.health();
    assert.equal(health.state, "NOT_CONFIGURED");

    const job = await provider.submitJob({
      id: "spec-hf",
      organizationId: "org-1",
      brandId: "brand-1",
      title: "Higgsfield Test",
      format: "ai_video",
      aspectRatio: "9:16",
      durationTargetSeconds: 5,
      hookLine: "HF Hook",
      script: "HF Script",
      scenes: [],
    });

    assert.equal(job.status, "NOT_CONFIGURED");
    assert.equal(job.jobId, "");
    assert.ok(job.error?.includes("not configured"));
  } finally {
    if (originalKey) process.env.HIGGSFIELD_API_KEY = originalKey;
  }
});

test("ManualCloudProvider returns PREFLIGHT_FAILED when Google Drive is disconnected", async () => {
  const fakeDrive = {
    async health() {
      return { status: "NOT_CONFIGURED" as const, detail: "No credentials", latencyMs: 0 };
    },
    async put() {
      throw new Error("Should not be called");
    },
    async get() {
      throw new Error("Should not be called");
    },
    async syncDropFolder() {
      return [];
    },
  } as any;

  const { ManualCloudProvider } = await import("./providers/manual-cloud.ts");
  const provider = new ManualCloudProvider(fakeDrive);
  const health = await provider.health();
  assert.equal(health.state, "NOT_CONFIGURED");

  const job = await provider.submitJob({
    id: "spec-mc",
    organizationId: "org-1",
    brandId: "brand-1",
    title: "Manual Cloud Test",
    format: "ugc",
    aspectRatio: "9:16",
    durationTargetSeconds: 30,
    hookLine: "Hook",
    script: "Script",
    scenes: [],
  });

  assert.equal(job.status, "PREFLIGHT_FAILED");
  assert.equal(job.error, "GOOGLE_DRIVE_NOT_CONFIGURED");
});
