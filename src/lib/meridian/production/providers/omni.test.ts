import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
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

test("GeminiOmniVideoProvider submits official REST Interactions API payload", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url.toString(), "https://generativelanguage.googleapis.com/v1beta/interactions");
    assert.equal(init?.method, "POST");
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers["x-goog-api-key"], "test-gemini-key");

    const body = JSON.parse(init?.body as string);
    assert.equal(body.model, "gemini-omni-1.1-flash");
    assert.equal(typeof body.input, "string");
    assert.ok(body.input.includes("Stop scrolling!"));
    assert.equal(body.response_format.type, "video");
    assert.equal(body.response_format.aspect_ratio, "9:16");

    return new Response(
      JSON.stringify({
        interaction_id: "interactions/omni-job-999",
        status: "in_progress",
        steps: [
          {
            step_id: "step_0",
            status: "in_progress",
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

test("GeminiOmniVideoProvider parses official REST steps[].content[] Base64 video and lowercase completed", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";
  const fakeBase64 = Buffer.from("fake-mp4-video-stream-content").toString("base64");

  const mockFetch = async (url: string | URL | Request) => {
    assert.ok(url.toString().includes("interactions/omni-job-999"));
    return new Response(
      JSON.stringify({
        interaction_id: "interactions/omni-job-999",
        status: "completed", // Lowercase completed per REST documentation
        steps: [
          {
            step_id: "step_0",
            type: "model_output",
            content: [
              {
                type: "video",
                mime_type: "video/mp4",
                data: fakeBase64,
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
  assert.ok(polled.metadata?.sha256);
  assert.equal(polled.metadata?.mimeType, "video/mp4");
  assert.ok((polled.metadata?.byteSize as number) > 0);
});

test("GeminiOmniVideoProvider supports image-to-video multimodal input structure", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";

  const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string);
    assert.equal(body.model, "gemini-omni-1.1-flash");
    assert.ok(Array.isArray(body.input));
    // Official typed input array: image part followed by text instruction
    assert.equal(body.input[0].type, "image");
    assert.equal(body.input[0].uri, "https://storage.googleapis.com/test-bucket/product.jpg");
    assert.equal(body.input[1].type, "text");
    assert.equal(body.input[1].text, "Stop scrolling!\nHere is the proof why this works.");
    assert.equal(body.response_format.type, "video");
    assert.equal(body.response_format.aspect_ratio, "9:16");

    return new Response(
      JSON.stringify({
        interaction_id: "interactions/omni-i2v-123",
        status: "completed",
        steps: [
          {
            type: "model_output",
            content: [
              {
                type: "video",
                uri: "https://storage.googleapis.com/test-bucket/output.mp4",
              },
            ],
          },
        ],
      }),
      { status: 200 }
    );
  };

  const provider = new GeminiOmniVideoProvider({
    fetchImpl: mockFetch as unknown as typeof fetch,
  });

  const specWithImage: CreativeSpec = {
    ...sampleSpec,
    sourceMediaUrl: "https://storage.googleapis.com/test-bucket/product.jpg",
  };

  const job = await provider.submitJob(specWithImage);
  assert.equal(job.status, "COMPLETED");
  assert.equal(job.outputArtifactId, "https://storage.googleapis.com/test-bucket/output.mp4");
});

test("E2E: Production poller consumes Omni Base64 video response and materializes real bytes to Drive", async () => {
  process.env.GEMINI_API_KEY = "test-gemini-key";
  const fakeVideoBytes = Buffer.from("\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2mp41test-omni-rendered-mp4-payload-bytes");
  const fakeBase64 = fakeVideoBytes.toString("base64");
  const expectedSha256 = createHash("sha256").update(fakeVideoBytes).digest("hex");

  const storedDrivePuts: Array<{ path: string; bytes: Uint8Array; mimeType: string }> = [];
  const mockDrive = {
    put: async (input: any) => {
      storedDrivePuts.push(input);
      return { fileId: "drive-file-123", webViewLink: "https://drive.google.com/test" };
    },
    get: async () => null,
    delete: async () => {},
    health: async () => ({ status: "CONFIGURED" as const, configured: true }),
  };

  const mockOmniFetch = async (_url: string | URL | Request) => {
    return new Response(
      JSON.stringify({
        interaction_id: "interactions/omni-e2e-poll-1",
        status: "completed",
        steps: [
          {
            type: "model_output",
            content: [
              {
                type: "video",
                mime_type: "video/mp4",
                data: fakeBase64,
              },
            ],
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const omniProvider = new GeminiOmniVideoProvider({
    fetchImpl: mockOmniFetch as unknown as typeof fetch,
  });

  const mockRouter = {
    get: (id: string) => (id === "google_omni" || id === "omni" ? omniProvider : undefined),
  };

  const dbUpdates: Array<string> = [];
  const mockSql = (async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const query = strings.join("?");
    if (query.includes("select id, organization_id")) {
      return [
        {
          id: "prod-job-omni-1",
          organization_id: "org-1",
          brand_id: "brand-1",
          provider: "google_omni",
          provider_job_id: "interactions/omni-e2e-poll-1",
          request_id: null,
          status_url: null,
          cancel_url: null,
          status: "RUNNING",
          attempt_count: 0,
          input: JSON.stringify({
            creativeSpec: {
              ...sampleSpec,
              durationTargetSeconds: 5,
            },
            runId: "run-omni-1",
          }),
        },
      ];
    }
    if (query.includes("update production_jobs")) {
      dbUpdates.push(query);
    }
    return [];
  }) as any;

  const { pollProductionJobs } = await import("../poller.ts");
  const pollResult = await pollProductionJobs(mockSql, {
    driveClient: mockDrive as any,
    router: mockRouter as any,
    fetchImpl: mockOmniFetch as unknown as typeof fetch,
  });

  // Verify poller rendered 1 job
  assert.equal(pollResult.claimed, 1);
  assert.equal(pollResult.rendered, 1);
  assert.equal(pollResult.failed, 0);

  // Verify bytes were materialized to Google Drive
  assert.equal(storedDrivePuts.length, 1);
  assert.equal(storedDrivePuts[0].bytes.byteLength, fakeVideoBytes.byteLength);
  assert.equal(storedDrivePuts[0].mimeType, "video/mp4");
  const actualHash = createHash("sha256").update(storedDrivePuts[0].bytes).digest("hex");
  assert.equal(actualHash, expectedSha256);

  // Verify DB state updated to COMPLETED
  assert.ok(dbUpdates.some((q) => q.includes("status = 'COMPLETED'")));
});

test("ModelCapabilityRegistry tracks Veo 3.1 deprecation and Veo 2.0 shutdown", () => {
  // Veo 3.1 preview deprecation
  const checkVeo31 = modelCapabilityRegistry.checkModelLifecycle(
    "veo-3.1-generate-preview",
    new Date("2026-10-09T00:00:00Z")
  );
  assert.equal(checkVeo31.state, "DEPRECATED");
  assert.equal(checkVeo31.usable, true);
  assert.ok(checkVeo31.warning?.includes("2026-10-22"));
  assert.equal(checkVeo31.replacement, "gemini-omni-1.1-flash");

  // Veo 2.0 GA is shut down as of 2026-06-30
  const checkVeo20 = modelCapabilityRegistry.checkModelLifecycle(
    "veo-2.0-generate-001",
    new Date("2026-10-09T00:00:00Z")
  );
  assert.equal(checkVeo20.state, "SHUTDOWN");
  assert.equal(checkVeo20.usable, false);

  // Active Omni model
  const checkOmni = modelCapabilityRegistry.checkModelLifecycle("gemini-omni-1.1-flash");
  assert.equal(checkOmni.state, "ACTIVE");
  assert.equal(checkOmni.usable, true);
});
