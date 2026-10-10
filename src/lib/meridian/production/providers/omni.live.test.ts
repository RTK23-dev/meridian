import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../../db.ts";
import { studioTenant } from "../../testing/durable-image-fixtures.ts";
import { storeVaultCredential } from "../../vault/service.ts";
import { fixedLookup } from "../../credentials/fixtures.ts";
import { GeminiOmniVideoProvider, buildOmniTextToVideoPayload } from "./omni.ts";
import type { CreativeSpec } from "../types.ts";

// The vault encrypts each workspace's saved production key with this master key. Only this test process uses it.
process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY || "test-master-key-omni-live-0123456789abcdef";

/**
 * The key for the live smoke test, when one is configured. It is handed to the provider as the workspace's key for that one
 * test. The provider itself never reads a key from the environment.
 */
const liveKey = process.env.MERIDIAN_GEMINI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_STUDIO_API_KEY || process.env.GOOGLE_API_KEY || "";

test("GeminiOmniVideoProvider Live Smoke Test (Credential-Gated)", { skip: !liveKey && "no live Gemini key is configured" }, async () => {
  const provider = new GeminiOmniVideoProvider({ lookup: fixedLookup(liveKey) });

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

  // 1. Health check returns canonical google_omni ID, and with no workspace it is never READY
  const health = await provider.health();
  assert.equal(health.id, "google_omni", "Provider ID must be canonical google_omni");
  assert.equal(health.state, "NOT_CONFIGURED", "without a workspace, the provider reports only that a workspace credential is needed");
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

  // 3. submitJob returns FAILED if duration is out of range. The workspace has its own saved key, so the duration check is reached.
  const sql = await getSql();
  const tenant = await studioTenant(sql, "omni-contract");
  await storeVaultCredential(sql, tenant.organizationId, "provider_config:production", { accessToken: "", apiKey: "test-key-contract" });
  const invalidSpec: CreativeSpec = {
    id: "spec-invalid-dur",
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
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
});
