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
      modality: "video", format: "ai_video",
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
      modality: "video", format: "ai_video",
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

test("HypitProvider returns NOT_CONFIGURED without URL and executes real HTTP when configured", async () => {
  const origUrl = process.env.HYPIT_BASE_URL;
  delete process.env.HYPIT_BASE_URL;

  try {
    const { HypitProvider } = await import("./providers/hypit.ts");
    const provider = new HypitProvider();
    const health = await provider.health();
    assert.equal(health.state, "NOT_CONFIGURED");

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
    });
    assert.equal(job.status, "NOT_CONFIGURED");
    assert.equal(job.jobId, "");
    assert.ok(job.error?.includes("not configured"));

    // Configured real HTTP test
    process.env.HYPIT_BASE_URL = "https://hypit.internal";
    const calledEndpoints: string[] = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      calledEndpoints.push(String(url));
      if (String(url).endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }
      if (String(url).endsWith("/v1/jobs") && init?.method === "POST") {
        const headers = init.headers as Record<string, string>;
        assert.equal(headers["idempotency-key"], "durable-job-key");
        const body = JSON.parse(String(init.body));
        assert.equal(body.meridianJobId, "prod_hypit_durable-job-key");
        return new Response(JSON.stringify({ id: "hypit-job-456", status: "queued" }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    };

    const configuredProvider = new HypitProvider({ fetchImpl: fakeFetch });
    const configuredHealth = await configuredProvider.health();
    assert.equal(configuredHealth.state, "HEALTHY");
    assert.ok(calledEndpoints.some((ep) => ep.includes("/health")));

    const submittedJob = await configuredProvider.submitJob({
      id: "spec-hypit-2",
      organizationId: "org-1",
      brandId: "brand-1",
      title: "Hypit Submit",
      modality: "video", format: "ugc",
      aspectRatio: "9:16",
      durationTargetSeconds: 10,
      hookLine: "Hook",
      script: "Script",
      scenes: [],
      idempotencyKey: "durable-job-key",
    });
    assert.equal(submittedJob.status, "RUNNING");
    assert.equal(submittedJob.jobId, "hypit-job-456");
    assert.ok(calledEndpoints.some((ep) => ep.includes("/v1/jobs")));
  } finally {
    if (origUrl) process.env.HYPIT_BASE_URL = origUrl;
    else delete process.env.HYPIT_BASE_URL;
  }
});

test("Hypit submission transport failure is explicitly unknown, not safely retryable", async () => {
  const originalUrl = process.env.HYPIT_BASE_URL;
  process.env.HYPIT_BASE_URL = "https://hypit.internal";
  try {
    const { HypitProvider } = await import("./providers/hypit.ts");
    const provider = new HypitProvider({ fetchImpl: async () => { throw new Error("connection reset after request write"); } });
    const result = await provider.submitJob({
      id: "spec-unknown", idempotencyKey: "durable-job-key", organizationId: "org-1", brandId: "brand-1",
      title: "Unknown outcome", modality: "video", format: "ugc", aspectRatio: "9:16", durationTargetSeconds: 8,
      hookLine: "Hook", script: "Script", scenes: [],
    });
    assert.equal(result.status, "SUBMISSION_UNKNOWN");
    assert.equal(result.jobId, "");
  } finally {
    if (originalUrl) process.env.HYPIT_BASE_URL = originalUrl;
    else delete process.env.HYPIT_BASE_URL;
  }
});

