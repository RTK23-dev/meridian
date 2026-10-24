import assert from "node:assert/strict";
import test from "node:test";
import { productionRouter } from "./router.ts";
import { evaluateImagePreflight, evaluateProductionPreflight } from "./preflight.ts";
import { evaluateProductionPostflight } from "./postflight.ts";
import type { CreativeSpec, ProductionJob } from "./types.ts";

test("productionRouter selects manual_cloud in ZERO_SPEND mode", () => {
  const spec: CreativeSpec = {
    id: "spec-1",
    organizationId: "org-1",
    brandId: "brand-1",
    title: "Test Creative",
    modality: "video", format: "ugc",
    aspectRatio: "9:16",
    durationTargetSeconds: 30,
    hookLine: "Stop scrolling!",
    script: "Here is why this works.",
    scenes: [],
  };

  const provider = productionRouter.routeTheoretical(spec, "ZERO_SPEND");
  assert.equal(provider.id, "manual_cloud");
  assert.equal(provider.capabilities.zeroSpend, true);
});

test("evaluateProductionPreflight blocks specs with missing required elements", () => {
  const invalidSpec: CreativeSpec = {
    id: "spec-invalid",
    organizationId: "org-1",
    brandId: "brand-1",
    title: "Empty Spec",
    modality: "video", format: "ugc",
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
    modality: "video", format: "ugc",
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

test("evaluateImagePreflight ignores duration and blocks an empty still", () => {
  const empty = evaluateImagePreflight({
    id: "img-empty",
    organizationId: "org-1",
    brandId: "brand-1",
    title: "Empty",
    modality: "image",
    format: "single_image",
    aspectRatio: "1:1",
    durationTargetSeconds: 0,
    hookLine: "",
    script: "",
    scenes: [],
  });
  assert.equal(empty.passed, false);
  const still = evaluateImagePreflight({
    id: "img-ok",
    organizationId: "org-1",
    brandId: "brand-1",
    title: "Still",
    modality: "image",
    format: "single_image",
    aspectRatio: "1:1",
    durationTargetSeconds: 0,
    hookLine: "Dry hands?",
    script: "North Soap is a gentle wash.",
    scenes: [],
  });
  assert.equal(still.passed, true);
  assert.equal(still.claimsJudged, false);
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
      modality: "video", format: "ugc",
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

test("GeminiOmniVideoProvider returns NOT_CONFIGURED and no job id without API key", async () => {
  const originalKey = process.env.GEMINI_API_KEY;
  const originalGoogleKey = process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;

  try {
    const { GeminiOmniVideoProvider } = await import("./providers/omni.ts");
    const provider = new GeminiOmniVideoProvider();
    const health = await provider.health();
    assert.equal(health.state, "NOT_CONFIGURED");

    const job = await provider.submitJob({
      id: "spec-omni",
      organizationId: "org-1",
      brandId: "brand-1",
      title: "Omni Test",
      modality: "video", format: "ai_video",
      aspectRatio: "9:16",
      durationTargetSeconds: 5,
      hookLine: "AI Hook",
      script: "AI Script",
      scenes: [],
    });

    assert.equal(job.status, "NOT_CONFIGURED");
    assert.equal(job.jobId, "");
    assert.match(job.error ?? "", /no saved Gemini credential/, "the reason names the missing workspace credential");
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
      modality: "video", format: "ai_video",
      aspectRatio: "9:16",
      durationTargetSeconds: 5,
      hookLine: "HF Hook",
      script: "HF Script",
      scenes: [],
    });

    assert.equal(job.status, "NOT_CONFIGURED");
    assert.equal(job.jobId, "");
    // Higgsfield's key is the deployment's, so the reason names the flag that would share it.
    assert.match(job.error ?? "", /PRODUCTION_SHARED_DEFAULT=deployment/);
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
      return { ok: true, files: [] };
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
    modality: "video", format: "ugc",
    aspectRatio: "9:16",
    durationTargetSeconds: 30,
    hookLine: "Hook",
    script: "Script",
    scenes: [],
  });

  assert.equal(job.status, "PREFLIGHT_FAILED");
  assert.equal(job.error, "GOOGLE_DRIVE_NOT_CONFIGURED");
});

test("HypitProvider refuses as not connected, even with a URL and a key, and sends no request", async () => {
  const origUrl = process.env.HYPIT_BASE_URL;
  process.env.HYPIT_BASE_URL = "https://hypit.internal";
  try {
    const { HypitProvider } = await import("./providers/hypit.ts");
    const calls: string[] = [];
    const provider = new HypitProvider({
      fetchImpl: async (url) => {
        calls.push(String(url));
        return new Response("{}", { status: 200 });
      },
      apiKey: "workspace-hypit-key",
    });
    const health = await provider.health();
    assert.equal(health.state, "NOT_CONFIGURED");
    assert.match(health.detail ?? "", /^NOT_CONNECTED: /);

    const job = await provider.submitJob({
      id: "spec-hypit",
      organizationId: "org-1",
      brandId: "brand-1",
      title: "Hypit Test",
      modality: "video", format: "ugc",
      aspectRatio: "9:16",
      durationTargetSeconds: 15,
      hookLine: "Hook",
      script: "Script",
      scenes: [],
      idempotencyKey: "durable-job-key",
    });
    assert.equal(job.status, "NOT_CONFIGURED");
    assert.equal(job.errorCode, "NOT_CONNECTED");
    assert.equal(job.jobId, "");
    assert.equal(calls.length, 0, "the production route sends nothing until it is wired to the Hypit handoff");
  } finally {
    if (origUrl) process.env.HYPIT_BASE_URL = origUrl;
    else delete process.env.HYPIT_BASE_URL;
  }
});

test("a refused Hypit submission is never reported as an unknown outcome, because nothing was sent", async () => {
  const originalUrl = process.env.HYPIT_BASE_URL;
  process.env.HYPIT_BASE_URL = "https://hypit.internal";
  try {
    const { HypitProvider } = await import("./providers/hypit.ts");
    let attempts = 0;
    const provider = new HypitProvider({
      fetchImpl: async () => {
        attempts += 1;
        throw new Error("connection reset after request write");
      },
      apiKey: "workspace-hypit-key",
    });
    const result = await provider.submitJob({
      id: "spec-unknown", idempotencyKey: "durable-job-key", organizationId: "org-1", brandId: "brand-1",
      title: "Unknown outcome", modality: "video", format: "ugc", aspectRatio: "9:16", durationTargetSeconds: 8,
      hookLine: "Hook", script: "Script", scenes: [],
    });
    assert.equal(result.status, "NOT_CONFIGURED");
    assert.notEqual(result.status, "SUBMISSION_UNKNOWN");
    assert.equal(result.jobId, "");
    assert.equal(attempts, 0);
  } finally {
    if (originalUrl) process.env.HYPIT_BASE_URL = originalUrl;
    else delete process.env.HYPIT_BASE_URL;
  }
});
