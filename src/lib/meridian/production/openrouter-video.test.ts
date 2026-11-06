// Studio videos through OpenRouter: the chosen model's durations, ratios and price come from the live video listing, the job is submitted
// and polled with the workspace's key through the gateway, and the router prices and prefers it for a workspace that chose it. No test
// reaches the network: the gateway's transport is a stand-in that answers like OpenRouter.

import assert from "node:assert/strict";
import test from "node:test";
import { createGateway } from "../../../engine/gateway/gateway.ts";
import type { CredentialSource, HttpRequest, HttpResponse } from "../../../engine/gateway/types.ts";
import { OPENROUTER_VIDEO_PROVIDER_ID, OpenRouterStudioVideoProvider, studioVideoPrice } from "./openrouter-video.ts";
import { ProductionRouter } from "./router.ts";
import type { CreativeSpec, ProductionProvider } from "./types.ts";

const MODEL = "google/veo-3.1";
const LISTING = {
  data: [
    { id: MODEL, supported_durations: [4, 6, 8], supported_resolutions: ["720p", "1080p"], supported_aspect_ratios: ["9:16", "16:9"], pricing_skus: { duration_seconds_1080p: "0.40" } },
    { id: "vendor/unpriced", supported_durations: [5], supported_resolutions: ["720p"], supported_aspect_ratios: ["9:16"] },
  ],
};
const json = (status: number, body: unknown): HttpResponse => ({ status, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(body)) });

function setup(options: { model?: string | null; submit?: HttpResponse; poll?: HttpResponse; connected?: boolean } = {}) {
  const requests: HttpRequest[] = [];
  const transport = async (request: HttpRequest): Promise<HttpResponse> => {
    requests.push(request);
    if (request.method === "GET" && request.url.endsWith("/videos/models")) return json(200, LISTING);
    if (request.method === "POST" && request.url.endsWith("/videos")) return options.submit ?? json(200, { id: "job-1", status: "pending" });
    if (request.method === "GET" && request.url.includes("/videos/job-1")) return options.poll ?? json(200, { id: "job-1", status: "in_progress" });
    return json(404, {});
  };
  const credentials: CredentialSource = {
    get: async () => (options.connected === false ? { status: "not_connected", reason: "No OpenRouter key is saved." } : { status: "ready", credential: { kind: "api_key", secret: "sk-test" } }),
  };
  const gateway = createGateway({ transport, credentials });
  const model = options.model === undefined ? MODEL : options.model;
  const provider = new OpenRouterStudioVideoProvider({ gateway, stored: async () => model, credentialStatus: async () => ({ status: "ready", reason: "", fingerprint: "...abcd" }) });
  return { provider, requests };
}

const spec = (overrides: Partial<CreativeSpec> = {}): CreativeSpec =>
  ({ id: "spec-1", organizationId: "org-1", brandId: "b", title: "t", modality: "video", format: "ugc", aspectRatio: "9:16", durationTargetSeconds: 8, hookLine: "Soap that lasts", script: "One bar, three months.", scenes: [], ...overrides }) as CreativeSpec;

test("the chosen model's durations, ratios and per-second price come from the live listing", async () => {
  const { provider } = setup();
  const offer = await provider.offerFor("org-1");
  assert.ok(!("unavailable" in offer));
  if ("unavailable" in offer) return;
  assert.deepEqual(offer, { model: MODEL, pricePerSecondUsd: 0.4, resolution: "1080p", durations: [4, 6, 8], aspectRatios: ["9:16", "16:9"], resolutions: ["720p", "1080p"] });
  assert.equal(studioVideoPrice(LISTING.data[1]!), null, "no stated price is unknown, never zero");
  assert.ok("unavailable" in (await setup({ model: null }).provider.offerFor("org-1")), "no chosen model, no offer");
  assert.ok("unavailable" in (await setup({ model: "vendor/not-listed" }).provider.offerFor("org-1")), "a model the listing does not name is not offered");
});

test("a job is submitted with the workspace's key, the chosen model and its 1080p resolution, and the workspace is kept for the poll", async () => {
  const { provider, requests } = setup();
  const job = await provider.submitJob(spec());
  assert.equal(job.status, "QUEUED");
  assert.equal(job.jobId, "job-1");
  assert.equal(job.metadata?.organizationId, "org-1");
  assert.ok(Math.abs(job.costEstimateUsd - 3.2) < 1e-9, "8 seconds at $0.40");
  const submit = requests.find((request) => request.method === "POST");
  assert.ok(submit);
  assert.equal(submit.headers.authorization ?? submit.headers.Authorization, "Bearer sk-test");
  const body = JSON.parse(typeof submit.body === "string" ? submit.body : new TextDecoder().decode(submit.body));
  assert.equal(body.model, MODEL);
  assert.equal(body.duration, 8);
  assert.equal(body.aspect_ratio, "9:16");
  assert.equal(body.resolution, "1080p");
  assert.match(body.prompt, /Soap that lasts/);
});

test("a refused submission fails, a server error is of unknown outcome, and no key means not configured", async () => {
  assert.equal((await setup({ submit: json(400, { error: "duration not supported" }) }).provider.submitJob(spec())).status, "FAILED");
  assert.equal((await setup({ submit: json(502, { error: "upstream" }) }).provider.submitJob(spec())).status, "SUBMISSION_UNKNOWN");
  assert.equal((await setup({ model: null }).provider.submitJob(spec())).status, "NOT_CONFIGURED");
});

test("a poll maps OpenRouter's states, and a finished video carries its URL and the reported cost", async () => {
  const running = await setup().provider.checkJobStatus("job-1", { organizationId: "org-1" });
  assert.equal(running.status, "RUNNING");
  const done = await setup({ poll: json(200, { id: "job-1", status: "completed", unsigned_urls: ["https://cdn.example/video.mp4"], usage: { cost: 3.1 } }) }).provider.checkJobStatus("job-1", { organizationId: "org-1" });
  assert.equal(done.status, "RENDERED");
  assert.equal(done.outputArtifactId, "https://cdn.example/video.mp4");
  assert.equal(done.costActualUsd, 3.1);
  assert.equal(done.metadata?.costBasis, "provider_reported");
  const failed = await setup({ poll: json(200, { id: "job-1", status: "failed", error: "safety" }) }).provider.checkJobStatus("job-1", { organizationId: "org-1" });
  assert.equal(failed.status, "FAILED");
  await assert.rejects(setup().provider.checkJobStatus("job-1", {}), /workspace that owns it/);
});

test("the router prices the workspace's chosen model from the listing, offers only its listed durations, and prefers it", async () => {
  const other = {
    id: "higgsfield",
    capabilities: { textToVideo: true, imageToVideo: true, timelineEditing: false, voiceoverGeneration: false, zeroSpend: false, averageLatencySeconds: 60, costPerSecondEstimateUsd: 0.15 },
    health: async () => ({ id: "higgsfield", state: "CONFIGURED", capabilities: [], detail: "", checkedAt: new Date().toISOString() }),
    submitJob: async () => { throw new Error("not called by selection"); },
    checkJobStatus: async () => { throw new Error("not called by selection"); },
  } as unknown as ProductionProvider;
  const { provider } = setup();
  const router = new ProductionRouter({ runtime: "testing", providers: [other, provider] });
  const chosen = await router.selectForSpec(spec(), "BALANCED");
  assert.equal(chosen.provider.id, OPENROUTER_VIDEO_PROVIDER_ID, "the workspace's explicit choice is its preference");
  assert.equal(chosen.selection.chosen?.costKnown, true);
  assert.ok(Math.abs((chosen.selection.chosen?.estimateUsd ?? 0) - 3.2) < 1e-9, "estimated from the listed price");
  const tooLong = await router.selectForSpec(spec({ durationTargetSeconds: 10 }), "BALANCED");
  assert.equal(tooLong.provider.id, "higgsfield", "a duration the model does not list is not sent to it");
});

test("the price follows the resolution the job asks for: 1080p first, then 720p, the with-audio price as a bound, else the default", () => {
  assert.deepEqual(studioVideoPrice({ supported_resolutions: ["720p", "1080p"], pricing_skus: { duration_seconds_720p: "0.2", duration_seconds_1080p: "0.4" } }), { usdPerSecond: 0.4, resolution: "1080p" });
  assert.deepEqual(studioVideoPrice({ supported_resolutions: ["720p", "1080p"], pricing_skus: { duration_seconds_720p: "0.2" } }), { usdPerSecond: 0.2, resolution: "720p" });
  // An Omni-style listing states only prices with audio: a job without audio is bounded by them.
  assert.deepEqual(
    studioVideoPrice({ supported_resolutions: ["360p", "720p", "4k"], pricing_skus: { duration_seconds_with_audio_720p: "0.069504", duration_seconds_with_audio_360p: "0.023172" } }),
    { usdPerSecond: 0.069504, resolution: "720p" },
  );
  assert.deepEqual(studioVideoPrice({ supported_resolutions: [], pricing_skus: { duration_seconds: "0.1" } }), { usdPerSecond: 0.1, resolution: undefined });
  assert.equal(studioVideoPrice({ pricing_skus: { duration_seconds_1080p: "0" } }), null, "a zero price is not a stated price");
});
