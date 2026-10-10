import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

// The runner resolves a credential for every run, exactly as production does. These tests use the deployment's shared default,
// which is the explicit setting that makes a Gemini key usable for perception without a saved workspace key.
process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY || "test-master-key-0123456789abcdef-test";
process.env.PERCEPTION_SHARED_DEFAULT = "gemini";
process.env.MERIDIAN_GEMINI_API_KEY = "test-shared-gemini-key";
import { getSql } from "../../db.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { solidFrame } from "../video/inspect.ts";
import type { MediaObservation, MultimodalPerceptionProvider, PerceptionHealth, PerceptionMedia, PerceptionMediaKind, PerceptionResult } from "./types.ts";
import { PERCEPTION_MAX_MEDIA, groundedPerceptionText, runPerception, selectPerceptionProvider, type PerceptionInputMedia } from "./run.ts";

// A stub perception provider. It records every call, so tests can prove when production calls it and when it does not.
function stubProvider(options: { health?: PerceptionHealth; fail?: "provider" | "throw"; id?: string; productPresence?: boolean | null } = {}) {
  const calls: Array<{ kind: PerceptionMediaKind; media: PerceptionMedia[] }> = [];
  const provider: MultimodalPerceptionProvider = {
    id: options.id ?? "stub_perception",
    model: "stub-model-1",
    promptVersion: "stub-prompt.v1",
    health: async () => options.health ?? { id: "stub_perception", state: "HEALTHY", detail: "ready" },
    perceive: async (input): Promise<PerceptionResult> => {
      calls.push(input);
      if (options.fail === "throw") throw new Error("socket reset");
      if (options.fail === "provider") {
        return { status: "failed", providerId: "stub_perception", model: "stub-model-1", promptVersion: "stub-prompt.v1", failureKind: "rate_limited", message: "stub limit", latencyMs: 1 };
      }
      const observations: MediaObservation[] = input.media.map((item) => ({
        mediaId: item.id, sha256: item.sha256, timestampMs: item.timestampMs, basis: "inferred", productPresence: options.productPresence === undefined ? true : options.productPresence, ocrText: "Lather bar",
      }));
      return { status: "observed", providerId: "stub_perception", model: "stub-model-1", promptVersion: "stub-prompt.v1", observations, latencyMs: 2 };
    },
  };
  return { provider, calls };
}

const frame = (color: [number, number, number], timestampMs: number, id = `frame-${timestampMs}`): PerceptionInputMedia => ({
  id, bytes: solidFrame(16, 16, color), timestampMs, label: `Frame at ${timestampMs}ms`,
});

const subject = (tenant: { organizationId: string; brandId: string }) => ({
  organizationId: tenant.organizationId,
  brandId: tenant.brandId,
  subjectType: "creative",
  subjectId: `creative-${randomUUID()}`,
});

test("provider selection is its own setting: unset and gemini select Gemini, none turns it off, an unknown value is refused with its reason", () => {
  assert.equal(selectPerceptionProvider({}).provider?.id, "gemini_multimodal");
  assert.equal(selectPerceptionProvider({ PERCEPTION_PROVIDER: "Gemini" }).provider?.id, "gemini_multimodal");
  const off = selectPerceptionProvider({ PERCEPTION_PROVIDER: "none" });
  assert.equal(off.provider, null);
  assert.match(off.reason, /turned off/);
  const unknown = selectPerceptionProvider({ PERCEPTION_PROVIDER: "some-other" });
  assert.equal(unknown.provider, null, "an unknown provider is not silently replaced");
  assert.match(unknown.reason, /not a known perception provider/);
});

test("an observed run records the media with its hashes and real timestamps, the model and prompt version, and the observations", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "perception-observed");
  const { provider, calls } = stubProvider();
  const outcome = await runPerception(sql, {
    ...subject(tenant), kind: "video_frames", durationMs: 3000, provider,
    media: [frame([255, 0, 0], 0), frame([0, 255, 0], 1500), frame([0, 0, 255], 2750)],
  });
  assert.equal(outcome.status, "observed");
  assert.equal(outcome.reused, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(outcome.media.map((item) => item.timestampMs), [0, 1500, 2750]);
  assert.ok(outcome.media.every((item) => /^[0-9a-f]{64}$/.test(item.sha256)));
  const [row] = await sql<{ status: string; model: string; prompt_version: string; media: unknown; observations: unknown }>`
    select status, model, prompt_version, media, observations from perception_runs where id = ${outcome.runId}
  `;
  assert.equal(row?.status, "observed");
  assert.equal(row?.model, "stub-model-1");
  assert.equal(row?.prompt_version, "stub-prompt.v1");
  assert.match(JSON.stringify(row?.media), /"timestampMs":1500/);
  assert.match(JSON.stringify(row?.observations), /"basis":"inferred"/);
});

test("an unknown fact is stated as unknown in the grounded text, never as absent", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "perception-unknown");
  const { provider } = stubProvider({ productPresence: null });
  const outcome = await runPerception(sql, { ...subject(tenant), kind: "image", durationMs: null, provider, media: [frame([10, 20, 30], 0)] });
  assert.equal(outcome.status, "observed");
  const text = groundedPerceptionText(outcome).join("\n");
  assert.match(text, /product unknown/, "the model's null is shown as unknown");
  assert.doesNotMatch(text, /product absent/, "null must not be read as a negative");
});

test("the grounded text says the observations are descriptions and that a video was only partly analysed", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "perception-text");
  const { provider } = stubProvider();
  const media = Array.from({ length: 6 }, (_, index) => frame([index * 40, 0, 0], index * 500));
  const outcome = await runPerception(sql, { ...subject(tenant), kind: "video_frames", durationMs: 3000, provider, media });
  const text = groundedPerceptionText(outcome);
  assert.ok(text.some((line) => line.startsWith("Frame at 0ms")), "the first frame is named with its real time");
  assert.ok(text.some((line) => /Inferred from the pixels by stub_perception stub-model-1/.test(line)), "the line says it is an inference, not a measurement");
  assert.ok(text.some((line) => /Analysed 4 of 6 sampled frames/.test(line)), "the coverage is stated");
  assert.ok(text.some((line) => /not inspected in full/.test(line)), "the video is not described as inspected in full");
});

test("more frames than the bound: the provider is called with the bound, and the coverage says how many were not analysed", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "perception-bound");
  const { provider, calls } = stubProvider();
  const media = Array.from({ length: 6 }, (_, index) => frame([0, index * 40, 0], index * 500));
  const outcome = await runPerception(sql, { ...subject(tenant), kind: "video_frames", durationMs: 3000, provider, media });
  assert.equal(calls[0]?.media.length, PERCEPTION_MAX_MEDIA);
  assert.equal(outcome.coverage.offered, 6);
  assert.equal(outcome.coverage.analysed, PERCEPTION_MAX_MEDIA);
});

test("an identical earlier run is reused: the provider is not called a second time for the same media", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "perception-dedupe");
  const { provider, calls } = stubProvider();
  const media = [frame([10, 20, 30], 0), frame([200, 10, 10], 1000)];
  const first = await runPerception(sql, { ...subject(tenant), kind: "video_frames", durationMs: 2000, provider, media });
  const second = await runPerception(sql, { ...subject(tenant), kind: "video_frames", durationMs: 2000, provider, media });
  assert.equal(calls.length, 1, "one provider call for two identical requests");
  assert.equal(second.reused, true);
  assert.equal(second.runId, first.runId, "the reused run is the one already recorded");
  assert.equal(second.observations.length, first.observations.length);
});

test("a provider failure is recorded with its kind, and no observation is made up for it", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "perception-failure");
  const { provider } = stubProvider({ fail: "provider" });
  const outcome = await runPerception(sql, { ...subject(tenant), kind: "image", provider, media: [{ id: "still", bytes: solidFrame(8, 8, [1, 1, 1]), timestampMs: null, label: "Generated image" }] });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.failureKind, "rate_limited");
  assert.deepEqual(outcome.observations, []);
  assert.equal(groundedPerceptionText(outcome).length, 0, "a failed run offers no grounded text");
  const [row] = await sql<{ status: string; failure_kind: string }>`select status, failure_kind from perception_runs where id = ${outcome.runId}`;
  assert.equal(row?.status, "failed");
  assert.equal(row?.failure_kind, "rate_limited");
});

test("a provider that throws is a recorded failure, not a crash", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "perception-throws");
  const { provider } = stubProvider({ fail: "throw" });
  const outcome = await runPerception(sql, { ...subject(tenant), kind: "image", provider, media: [{ id: "still", bytes: solidFrame(8, 8, [2, 2, 2]), timestampMs: null, label: "Generated image" }] });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.failureKind, "provider_unavailable");
});

test("no provider, or an unhealthy one, means no call and an explicit reason", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "perception-unavailable");
  const none = await runPerception(sql, { ...subject(tenant), kind: "image", provider: null, providerReason: "PERCEPTION_PROVIDER=none", media: [{ id: "still", bytes: solidFrame(8, 8, [3, 3, 3]), timestampMs: null, label: "Generated image" }] });
  assert.equal(none.status, "failed");
  assert.equal(none.failureKind, "not_configured");
  assert.match(none.message ?? "", /PERCEPTION_PROVIDER=none/);
  const { provider, calls } = stubProvider({ health: { id: "stub_perception", state: "NOT_CONFIGURED", detail: "no key" } });
  const unhealthy = await runPerception(sql, { ...subject(tenant), kind: "image", provider, media: [{ id: "still", bytes: solidFrame(8, 8, [4, 4, 4]), timestampMs: null, label: "Generated image" }] });
  assert.equal(unhealthy.failureKind, "not_configured");
  assert.equal(calls.length, 0, "an unhealthy provider is not called");
});

test("invalid bytes are refused before any call, and the whole run fails rather than analysing part of it", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "perception-invalid");
  const { provider, calls } = stubProvider();
  const outcome = await runPerception(sql, {
    ...subject(tenant), kind: "video_frames", provider,
    media: [frame([5, 5, 5], 0), { id: "bad", bytes: new Uint8Array([9, 9, 9]), timestampMs: 500, label: "Frame at 500ms" }],
  });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.failureKind, "unsupported_media");
  assert.equal(calls.length, 0);
});
