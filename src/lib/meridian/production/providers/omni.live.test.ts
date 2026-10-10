import assert from "node:assert/strict";
import test from "node:test";
import { GeminiOmniVideoProvider, buildOmniTextToVideoPayload } from "./omni.ts";
import type { CreativeSpec } from "../types.ts";

const hasGoogleCreds = Boolean(
  (process.env.GOOGLE_CLOUD_PROJECT && process.env.GOOGLE_APPLICATION_CREDENTIALS) ||
  process.env.GEMINI_API_KEY
);

test("GeminiOmniVideoProvider Live Smoke Test (Credential-Gated)", { skip: !hasGoogleCreds }, async (t) => {
  if (!hasGoogleCreds) {
    t.skip("Skipping Gemini Omni Live Test: GOOGLE_APPLICATION_CREDENTIALS or GEMINI_API_KEY not configured.");
    return;
  }

  const provider = new GeminiOmniVideoProvider();

  const spec: CreativeSpec = {
    id: "spec-live-omni-1",
    organizationId: "org-live-test",
    brandId: "brand-live-test",
    title: "EcoBottle Live Reel",
    modality: "video", format: "video_ugc",
    aspectRatio: "9:16",
    durationTargetSeconds: 6,
    hookLine: "Still using single-use plastic in 2026?",
    script: "Still using single-use plastic in 2026?\nSwitch to the self-cleaning EcoBottle.\nTap below for 20% off.",
    scenes: [
      { index: 0, description: "A person frowning at a crushed plastic water bottle.", durationSeconds: 2 },
      { index: 1, description: "Pouring crystal-clear water into a sleek insulated EcoBottle.", durationSeconds: 2 },
      { index: 2, description: "Bottle on outdoor table with '20% OFF TODAY' text overlay.", durationSeconds: 2 },
    ],
  };

  const job = await provider.submitJob(spec);
  assert.ok(job, "Provider must return a job submission result");
  assert.ok(job.status === "RUNNING" || job.status === "COMPLETED" || job.status === "RENDERED" || job.status === "QUEUED", `Job status must be valid, got: ${job.status}`);
  assert.ok(job.providerJobId || job.jobId, "Job must have a provider tracking ID");
});

test("GeminiOmniVideoProvider Contract & Duration Limits Validation", async () => {
  const provider = new GeminiOmniVideoProvider();

  // 1. Health check returns canonical google_omni ID
  const health = await provider.health();
  assert.equal(health.id, "google_omni", "Provider ID must be canonical google_omni");
  assert.equal(provider.capabilities.textToVideo, true, "Must support textToVideo");

  // 2. Payload builder enforces 3s to 10s duration constraint
  const validPayload = buildOmniTextToVideoPayload({
    model: "gemini-omni-1.1-flash",
    prompt: "A quick product demo",
    durationSeconds: 5,
    aspectRatio: "9:16",
  });
  assert.equal(validPayload.model, "gemini-omni-1.1-flash");

  assert.throws(
    () => buildOmniTextToVideoPayload({
      model: "gemini-omni-1.1-flash",
      prompt: "Too long",
      durationSeconds: 25,
    }),
    /Gemini Omni supports video durations between 3 and 10 seconds/,
    "Omni must reject duration > 10s",
  );

  assert.throws(
    () => buildOmniTextToVideoPayload({
      model: "gemini-omni-1.1-flash",
      prompt: "Too short",
      durationSeconds: 2,
    }),
    /Gemini Omni supports video durations between 3 and 10 seconds/,
    "Omni must reject duration < 3s",
  );

  // 3. submitJob returns FAILED if duration is out of range
  const oldKey = process.env.MERIDIAN_GEMINI_API_KEY;
  try {
    process.env.MERIDIAN_GEMINI_API_KEY = "test-key-contract";
    const invalidSpec: CreativeSpec = {
      id: "spec-invalid-dur",
      organizationId: "org-test",
      brandId: "brand-test",
      title: "Too Long Spec",
      modality: "video", format: "video_ugc",
      aspectRatio: "9:16",
      durationTargetSeconds: 20,
      hookLine: "Hook",
      script: "Script",
      scenes: [],
    };
    const failedJob = await provider.submitJob(invalidSpec);
    assert.equal(failedJob.status, "FAILED");
    assert.ok(failedJob.error?.includes("duration"), "Error must cite duration limit");
  } finally {
    process.env.MERIDIAN_GEMINI_API_KEY = oldKey;
  }
});
