import assert from "node:assert/strict";
import test from "node:test";
import { GeminiOmniVideoProvider } from "./omni.ts";
import { modelCapabilityRegistry } from "../registry.ts";
import type { CreativeSpec } from "../types.ts";

const sampleSpec: CreativeSpec = {
  id: "spec-test-1",
  organizationId: "org-test",
  brandId: "brand-test",
  title: "Test Creative",
  format: "reel",
  aspectRatio: "9:16",
  durationTargetSeconds: 5,
  hookLine: "Stop scrolling!",
  script: "Here is the proof why this works.",
  scenes: [
    { index: 0, description: "Opening shot", durationSeconds: 5 },
  ],
};

test("GeminiOmniVideoProvider reports NOT_CONFIGURED when API key is missing", async () => {
  const origKey = process.env.GEMINI_API_KEY;
  const origGoogleKey = process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;

  try {
    const provider = new GeminiOmniVideoProvider();
    const health = await provider.health();
    assert.equal(health.state, "NOT_CONFIGURED");

    const job = await provider.submitJob(sampleSpec);
    assert.equal(job.status, "NOT_CONFIGURED");
  } finally {
    if (origKey) process.env.GEMINI_API_KEY = origKey;
    if (origGoogleKey) process.env.GOOGLE_API_KEY = origGoogleKey;
  }
});

test("GeminiOmniVideoProvider submits typed request to Interactions API and handles response", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url.toString(), "https://generativelanguage.googleapis.com/v1beta/interactions");
    assert.equal(init?.method, "POST");
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers["x-goog-api-key"], "test-gemini-key");

    const body = JSON.parse(init?.body as string);
    assert.equal(body.model, "gemini-omni-1.1-flash");
    assert.equal(body.input.task, "text-to-video");
    assert.equal(body.input.parameters.aspect_ratio, "9:16");

    return new Response(
      JSON.stringify({
        interaction_id: "interactions/omni-job-999",
        status: "RUNNING",
        steps: [
          {
            step_id: "step_0",
            status: "RUNNING",
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const provider = new GeminiOmniVideoProvider({
    fetchImpl: mockFetch as unknown as typeof fetch,
  });

  const job = await provider.submitJob(sampleSpec);
  assert.equal(job.status, "RUNNING");
  assert.equal(job.providerJobId, "interactions/omni-job-999");
  assert.equal(job.providerId, "google_omni");
});

test("GeminiOmniVideoProvider checkJobStatus polls interaction and retrieves video output URI", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  const mockFetch = async (url: string | URL | Request) => {
    assert.ok(url.toString().includes("interactions/omni-job-999"));
    return new Response(
      JSON.stringify({
        interaction_id: "interactions/omni-job-999",
        status: "COMPLETED",
        steps: [
          {
            step_id: "step_0",
            status: "COMPLETED",
            outputs: [
              {
                type: "video",
                uri: "https://storage.googleapis.com/test-bucket/omni-output.mp4",
                mime_type: "video/mp4",
              },
            ],
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const provider = new GeminiOmniVideoProvider({
    fetchImpl: mockFetch as unknown as typeof fetch,
  });

  const polled = await provider.checkJobStatus("interactions/omni-job-999");
  assert.equal(polled.status, "COMPLETED");
  assert.equal(polled.outputArtifactId, "https://storage.googleapis.com/test-bucket/omni-output.mp4");
});

test("ModelCapabilityRegistry tracks Veo 3.1 preview deprecation and replacement", () => {
  // Before shutdown date (2026-10-09)
  const checkBefore = modelCapabilityRegistry.checkModelLifecycle(
    "veo-3.1-generate-preview",
    new Date("2026-10-09T00:00:00Z")
  );
  assert.equal(checkBefore.state, "DEPRECATED");
  assert.equal(checkBefore.usable, true);
  assert.ok(checkBefore.warning?.includes("2026-10-22"));
  assert.equal(checkBefore.replacement, "gemini-omni-1.1-flash");

  // After shutdown date (2026-10-23)
  const checkAfter = modelCapabilityRegistry.checkModelLifecycle(
    "veo-3.1-generate-preview",
    new Date("2026-10-23T00:00:00Z")
  );
  assert.equal(checkAfter.state, "SHUTDOWN");
  assert.equal(checkAfter.usable, false);

  // Active Omni model
  const checkOmni = modelCapabilityRegistry.checkModelLifecycle("gemini-omni-1.1-flash");
  assert.equal(checkOmni.state, "ACTIVE");
  assert.equal(checkOmni.usable, true);
});
