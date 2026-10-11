import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { getSql } from "../../../db.ts";
import { createTenantFixture } from "../../testing/production-fixtures.ts";
import { studioTenant } from "../../testing/durable-image-fixtures.ts";
import { storeVaultCredential } from "../../vault/service.ts";
import {
  GeminiOmniVideoProvider,
  buildOmniTextToVideoPayload,
  buildOmniImageToVideoPayload,
  validateOmniTask,
} from "./omni.ts";
import { modelCapabilityRegistry } from "../registry.ts";
import type { CreativeSpec } from "../types.ts";

// The vault encrypts saved keys with this master key. Only this test process uses it.
process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY || "test-master-key-omni-0123456789abcdef";

const sampleSpec: CreativeSpec = {
  id: "spec-test-1",
  organizationId: "org-test",
  brandId: "brand-test",
  title: "Test Creative",
  modality: "video", format: "reel",
  aspectRatio: "9:16",
  durationTargetSeconds: 5,
  hookLine: "Stop scrolling!",
  script: "Here is the proof why this works.",
  scenes: [
    { index: 0, description: "Opening shot", durationSeconds: 5 },
  ],
};

/**
 * A real workspace, optionally with a saved production key. The keys in these tests come from the workspace's vault entry,
 * never from the environment.
 */
async function workspace(apiKey?: string) {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "omni");
  if (apiKey) {
    await storeVaultCredential(sql, tenant.organizationId, "provider_config:production", { accessToken: "", apiKey });
  }
  return tenant;
}

function specFor(tenant: { organizationId: string; brandId: string }, extra: Partial<CreativeSpec> = {}): CreativeSpec {
  return { ...sampleSpec, organizationId: tenant.organizationId, brandId: tenant.brandId, ...extra };
}

test("GeminiOmniVideoProvider reports NOT_CONFIGURED without a workspace, and never READY", async () => {
  const provider = new GeminiOmniVideoProvider();
  const health = await provider.health();
  assert.equal(health.state, "NOT_CONFIGURED");
  assert.match(health.detail, /workspace production credential/);
});

test("GeminiOmniVideoProvider reports NOT_CONFIGURED for a workspace with no saved key, and makes no request", async () => {
  const tenant = await workspace();
  let calls = 0;
  const provider = new GeminiOmniVideoProvider({
    fetchImpl: (async () => { calls++; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch,
  });
  assert.equal((await provider.healthFor(tenant.organizationId)).state, "NOT_CONFIGURED");

  const job = await provider.submitJob(specFor(tenant));
  assert.equal(job.status, "NOT_CONFIGURED");
  assert.equal(calls, 0, "no provider request is made without a usable key");
});

test("GeminiOmniVideoProvider submits official REST Interactions API payload with the workspace key", async () => {
  const tenant = await workspace("test-gemini-key");

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

  const job = await provider.submitJob(specFor(tenant));
  assert.equal(job.status, "RUNNING");
  assert.equal(job.providerJobId, "interactions/omni-job-999");
  assert.equal(job.providerId, "google_omni");
  assert.equal(job.metadata?.organizationId, tenant.organizationId, "the job records the workspace that owns it");
});

test("Gemini Omni preserves an ambiguous submission as unknown and never synthesizes a provider request id", async () => {
  const tenant = await workspace("test-gemini-key");
  const transportFailure = new GeminiOmniVideoProvider({
    fetchImpl: (async () => { throw new Error("connection reset after request write"); }) as unknown as typeof fetch,
  });
  assert.equal((await transportFailure.submitJob(specFor(tenant, { idempotencyKey: "durable-job-key" }))).status, "SUBMISSION_UNKNOWN");

  const missingProviderId = new GeminiOmniVideoProvider({
    fetchImpl: (async () => new Response(JSON.stringify({ status: "in_progress" }), { status: 200 })) as unknown as typeof fetch,
  });
  const result = await missingProviderId.submitJob(specFor(tenant, { idempotencyKey: "durable-job-key" }));
  assert.equal(result.status, "SUBMISSION_UNKNOWN");
  assert.equal(result.providerJobId, undefined);
});

test("GeminiOmniVideoProvider parses official REST steps[].content[] Base64 video and lowercase completed", async () => {
  const tenant = await workspace("test-gemini-key");
  const fakeBase64 = Buffer.from("fake-mp4-video-stream-content").toString("base64");

  const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
    assert.ok(url.toString().includes("interactions/omni-job-999"));
    assert.equal((init?.headers as Record<string, string>)["x-goog-api-key"], "test-gemini-key");
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

  const polled = await provider.checkJobStatus("interactions/omni-job-999", { organizationId: tenant.organizationId });
  assert.equal(polled.status, "COMPLETED");
  assert.ok(polled.metadata?.sha256);
  assert.equal(polled.metadata?.mimeType, "video/mp4");
  assert.ok((polled.metadata?.byteSize as number) > 0);
});

test("GeminiOmniVideoProvider polls only with the key of the workspace that owns the job", async () => {
  const owner = await workspace("owner-gemini-key");
  const other = await workspace();
  const keys: Array<string | null> = [];
  const provider = new GeminiOmniVideoProvider({
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get("x-goog-api-key"));
      return new Response(JSON.stringify({ status: "in_progress" }), { status: 200 });
    }) as unknown as typeof fetch,
  });

  const unowned = await provider.checkJobStatus("interactions/omni-job-1", {});
  assert.equal(unowned.status, "NOT_CONFIGURED", "a poll with no owning workspace sends nothing");

  const foreign = await provider.checkJobStatus("interactions/omni-job-1", { organizationId: other.organizationId });
  assert.equal(foreign.status, "NOT_CONFIGURED", "a workspace with no key of its own cannot poll another workspace's job");
  assert.deepEqual(keys, [], "neither refused poll sent a request");

  const owned = await provider.checkJobStatus("interactions/omni-job-1", { organizationId: owner.organizationId });
  assert.equal(owned.status, "RUNNING");
  assert.deepEqual(keys, ["owner-gemini-key"], "the owner's poll carries the owner's key");
});

test("GeminiOmniVideoProvider supports image-to-video multimodal input structure", async () => {
  const tenant = await workspace("test-gemini-key");

  const mockFetch = async (_url: string | URL | Request, init?: RequestInit) => {
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

  const specWithImage = specFor(tenant, {
    sourceMediaUrl: "https://storage.googleapis.com/test-bucket/product.jpg",
  });

  const job = await provider.submitJob(specWithImage);
  assert.equal(job.status, "COMPLETED");
  assert.equal(job.outputArtifactId, "https://storage.googleapis.com/test-bucket/output.mp4");
});

test("E2E: Production poller consumes Omni Base64 video response and materializes real bytes to Drive", async () => {
  const sql = await getSql();
  const fakeVideoBytes = Buffer.from("\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2mp41test-omni-rendered-mp4-payload-bytes");
  const fakeBase64 = fakeVideoBytes.toString("base64");
  const expectedSha256 = createHash("sha256").update(fakeVideoBytes).digest("hex");

  const storedDrivePuts: Array<{ path: string; bytes: Uint8Array; mimeType: string }> = [];
  const mockDrive = {
    put: async (input: any) => {
      storedDrivePuts.push(input);
      return { fileId: `drive-file-${randomUUID()}`, webViewLink: "https://drive.google.com/test" };
    },
    get: async (fileId: string) => ({
      fileId,
      bytes: new Uint8Array(fakeVideoBytes),
      name: "artifact.mp4",
      mimeType: "video/mp4",
    }),
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
            content: [{ type: "video", mime_type: "video/mp4", data: fakeBase64 }],
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  // A real tenant and a durable job row, as the executor leaves it while the render is in flight. The workspace has its own
  // saved production key, which the poller's job metadata leads the provider to.
  const tenant = await createTenantFixture(sql, "omni-poll", 50, "google_omni", "gemini-omni-1.1-flash");
  await storeVaultCredential(sql, tenant.organizationId, "provider_config:production", { accessToken: "", apiKey: "test-gemini-key" });
  const omniProvider = new GeminiOmniVideoProvider({
    fetchImpl: mockOmniFetch as unknown as typeof fetch,
  });
  const mockRouter = {
    get: (id: string) => (id === "google_omni" || id === "omni" ? omniProvider : undefined),
  };

  const jobId = `prod-job-omni-${randomUUID()}`;
  const input = {
    creativeSpec: { ...sampleSpec, durationTargetSeconds: 5 },
    runId: `run-omni-${randomUUID()}`,
    briefId: tenant.briefId,
    planDeliverableId: "deliverable-omni",
    manifest: { brand: { product: "Mesh sponge" }, hook: { type: "problem", text: "Tired" }, concept: { mechanism: "demo" } },
  };
  await sql`
    insert into production_jobs (
      id, organization_id, brand_id, provider, provider_job_id, status, cost_mode, estimated_cost_cents,
      input, created_at, submitted_at, updated_at, creative_plan_id
    ) values (
      ${jobId}, ${tenant.organizationId}, ${tenant.brandId}, 'google_omni', 'interactions/omni-e2e-poll-1', 'RUNNING', 'BALANCED', 0,
      ${JSON.stringify(input)}, now(), now(), now(), ${tenant.plan.id}
    )
  `;

  const { pollProductionJobs } = await import("../poller.ts");
  const pollResult = await pollProductionJobs(sql, {
    organizationId: tenant.organizationId,
    driveClient: mockDrive as any,
    router: mockRouter as any,
    fetchImpl: mockOmniFetch as unknown as typeof fetch,
  });

  assert.equal(pollResult.claimed, 1);
  assert.equal(pollResult.rendered, 1);
  assert.equal(pollResult.failed, 0);

  // Bytes were materialized to Google Drive and match the provider payload.
  assert.equal(storedDrivePuts.length, 1);
  assert.equal(storedDrivePuts[0].bytes.byteLength, fakeVideoBytes.byteLength);
  assert.equal(storedDrivePuts[0].mimeType, "video/mp4");
  const actualHash = createHash("sha256").update(storedDrivePuts[0].bytes).digest("hex");
  assert.equal(actualHash, expectedSha256);

  // Durable state: the job is COMPLETED with its artifact registered and materialized, and the
  // resulting creative waits in human review.
  const [row] = await sql<{ status: string; artifact_id: string | null; materialized_at: unknown }>`
    select status, artifact_id, materialized_at from production_jobs where id = ${jobId}
  `;
  assert.equal(row!.status, "COMPLETED");
  assert.ok(row!.artifact_id, "artifact is registered");
  assert.ok(row!.materialized_at, "artifact is materialized");
  const [creative] = await sql<{ status: string }>`select status from creative_records where id = ${`video-creative-${jobId}`}`;
  assert.equal(creative!.status, "in_review");
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

test("Omni task payloads include documented generation_config.video_config.task", () => {
  // 1. Text-to-video builder
  const textPayload = buildOmniTextToVideoPayload({
    model: "gemini-omni-1.1-flash",
    prompt: "A neon storefront in Tokyo",
    aspectRatio: "9:16",
    durationSeconds: 10,
  });

  assert.equal(textPayload.model, "gemini-omni-1.1-flash");
  assert.equal(textPayload.input, "A neon storefront in Tokyo");
  assert.deepEqual(textPayload.generation_config, {
    video_config: {
      task: "text_to_video",
      duration_seconds: 10,
    },
  });
  assert.deepEqual(textPayload.response_format, {
    type: "video",
    aspect_ratio: "9:16",
  });

  // 2. Image-to-video builder
  const imagePayload = buildOmniImageToVideoPayload({
    model: "gemini-omni-1.1-flash",
    prompt: "Animate camera zooming in on bottle",
    referenceImageUri: "https://storage.googleapis.com/assets/bottle.jpg",
    aspectRatio: "16:9",
  });

  assert.equal(imagePayload.model, "gemini-omni-1.1-flash");
  assert.ok(Array.isArray(imagePayload.input));
  assert.equal((imagePayload.input as any[])[0].type, "image");
  assert.equal((imagePayload.input as any[])[0].uri, "https://storage.googleapis.com/assets/bottle.jpg");
  assert.equal((imagePayload.input as any[])[1].type, "text");
  assert.equal((imagePayload.input as any[])[1].text, "Animate camera zooming in on bottle");
  assert.deepEqual(imagePayload.generation_config, {
    video_config: {
      task: "image_to_video",
    },
  });

  // 3. Task validator rejects unknown tasks
  validateOmniTask("text_to_video");
  validateOmniTask("image_to_video");
  assert.throws(
    () => validateOmniTask("unsupported_video_edit" as any),
    /Unsupported Omni task 'unsupported_video_edit'/
  );
});

test("Omni payload builder rejects durations outside 3-10 seconds", () => {
  assert.throws(
    () => buildOmniTextToVideoPayload({ model: "gemini-omni-1.1-flash", prompt: "test", durationSeconds: 15 }),
    /Gemini Omni supports video durations between 3 and 10 seconds/
  );
  assert.throws(
    () => buildOmniTextToVideoPayload({ model: "gemini-omni-1.1-flash", prompt: "test", durationSeconds: 2 }),
    /Gemini Omni supports video durations between 3 and 10 seconds/
  );
  assert.throws(
    () => buildOmniImageToVideoPayload({ model: "gemini-omni-1.1-flash", prompt: "test", referenceImageUri: "https://example.com/img.jpg", durationSeconds: 30 }),
    /Gemini Omni supports video durations between 3 and 10 seconds/
  );
});
