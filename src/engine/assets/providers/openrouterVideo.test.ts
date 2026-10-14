import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError } from "../../contracts/errors.ts";
import { ProviderCallError } from "../classify.ts";
import { classifyError } from "../classify.ts";
import { routes } from "../../config/routes.ts";
import { assetSpec, fixture, gatewayFor, json, routesWith, scripted, staticKeys } from "../test/recorded.ts";
import { openRouterVideoAdapter, videoProfilesFromListing, listVideoModels, type VideoProfile } from "./openrouterVideo.ts";
import { createGateway } from "../../gateway/gateway.ts";

const KLING = "kwaivgi/kling-v3.0-std";
const SUBMIT_PATH = "POST /api/v1/videos";
const POLL_PATH = "GET /api/v1/videos/job-abc123";

function profiles(): Map<string, VideoProfile> {
  return videoProfilesFromListing(fixture("video-models.json")).profiles;
}

function klingAdapter(options: { keys?: Record<string, string>; transport?: Parameters<typeof gatewayFor>[0] } = {}) {
  const script = scripted({});
  const gateway = gatewayFor(options.transport ?? script.transport, options.keys ? { keys: options.keys } : {});
  const route = gateway.routes("video.cinematic")[0];
  if (!route) throw new Error("no kling route");
  return { gateway, route, profile: profiles().get(KLING) ?? null, requests: script.requests };
}

describe("video profiles from GET /videos/models", () => {
  it("reads durations, frames and aspects, and rejects an entry that does not match the listing", () => {
    const { profiles: found, rejected } = videoProfilesFromListing(fixture("video-models.json"));
    assert.deepEqual(found.get(KLING)?.durations, [5, 10]);
    assert.equal(found.get(KLING)?.capabilities.firstFrame, true);
    assert.equal(found.get(KLING)?.capabilities.lastFrame, true);
    assert.equal(found.get(KLING)?.capabilities.refsMax, 0, "the listing does not report references");
    assert.equal(found.get("bytedance/seedance-2.0")?.capabilities.firstFrame, false);
    assert.equal(found.get("alibaba/wan-2.6")?.capabilities.lastFrame, false);
    assert.deepEqual(rejected, [{ id: "broken/entry", reason: "the entry does not match the listing shape" }]);
  });

  it("refuses a listing that is not an object with a data array", () => {
    const parsed = videoProfilesFromListing({ models: [] });
    assert.equal(parsed.profiles.size, 0);
    assert.equal(parsed.rejected.length, 1);
  });

  it("reads the listing through the gateway (GET /videos/models)", async () => {
    const script = scripted({ "GET /api/v1/videos/models": json(200, fixture("video-models.json")) });
    const gateway = gatewayFor(script.transport);
    const listing = await listVideoModels(gateway, "org_1");
    assert.equal(videoProfilesFromListing(listing).profiles.size, 4);
    assert.equal(script.requests[0]?.url, "https://openrouter.ai/api/v1/videos/models");
    assert.equal(script.requests[0]?.headers.Authorization, "Bearer sk-or-test");
  });
});

describe("OpenRouter video submit", () => {
  it("sends the routed model, the 9:16 1080p request and both frames, with generated audio off", async () => {
    const script = scripted({ [SUBMIT_PATH]: json(200, fixture("video-submit-pending.json")) });
    const { gateway, route, profile } = klingAdapter({ transport: script.transport });
    const adapter = openRouterVideoAdapter({ gateway, organizationId: "org_1", route, profile });
    const spec = assetSpec({
      firstFrame: "https://assets.example.com/first.jpg",
      lastFrame: "https://assets.example.com/last.jpg",
    });
    const { jobRef } = await adapter.submit(spec, "sha256:key");

    assert.equal(jobRef, "job-abc123");
    const sent = JSON.parse(String(script.requests[0]?.body));
    assert.equal(script.requests[0]?.url, "https://openrouter.ai/api/v1/videos");
    assert.equal(script.requests[0]?.headers.Authorization, "Bearer sk-or-test");
    assert.equal(sent.model, KLING);
    assert.equal(sent.prompt, spec.prompt);
    assert.equal(sent.duration, 5);
    assert.equal(sent.aspect_ratio, "9:16");
    assert.equal(sent.resolution, "1080p");
    assert.equal(sent.generate_audio, false);
    assert.deepEqual(sent.frame_images, [
      { type: "image_url", image_url: { url: "https://assets.example.com/first.jpg" }, frame_type: "first_frame" },
      { type: "image_url", image_url: { url: "https://assets.example.com/last.jpg" }, frame_type: "last_frame" },
    ]);
  });

  it("sends no frame_images when the spec has none", async () => {
    const script = scripted({ [SUBMIT_PATH]: json(200, fixture("video-submit-pending.json")) });
    const { gateway, route, profile } = klingAdapter({ transport: script.transport });
    await openRouterVideoAdapter({ gateway, organizationId: "org_1", route, profile }).submit(assetSpec(), "k");
    assert.equal(JSON.parse(String(script.requests[0]?.body)).frame_images, undefined);
  });

  it("refuses an unsupported request before any call is made", async () => {
    const script = scripted({ [SUBMIT_PATH]: json(200, fixture("video-submit-pending.json")) });
    const { gateway, route, profile } = klingAdapter({ transport: script.transport });
    const adapter = openRouterVideoAdapter({ gateway, organizationId: "org_1", route, profile });
    await assert.rejects(adapter.submit(assetSpec({ durationMs: 6000 }), "k"), (error: unknown) => {
      assert.ok(error instanceof EngineError);
      assert.equal(error.kind, "invalid_input");
      return true;
    });
    await assert.rejects(adapter.submit(assetSpec({ refs: ["https://a.example.com/r.jpg"] }), "k"), EngineError);
    await assert.rejects(adapter.submit(assetSpec({ firstFrame: "http://insecure.example.com/f.jpg" }), "k"), EngineError);
    await assert.rejects(adapter.submit(assetSpec({ aspect: "9:16" as const, durationMs: 5500 }), "k"), EngineError);
    assert.equal(script.requests.length, 0);
  });

  it("refuses a first frame on a model whose listing has none (Seedance)", async () => {
    const script = scripted({});
    const table = routesWith("video.cinematic", [{ provider: "openrouter", model: "bytedance/seedance-2.0", priceKey: "seedance_2_5", verified: false }], routes.table);
    const gateway = gatewayFor(script.transport, { routes: table });
    const route = gateway.routes("video.cinematic")[0];
    if (!route) throw new Error("no seedance route");
    const adapter = openRouterVideoAdapter({ gateway, organizationId: "org_1", route, profile: profiles().get("bytedance/seedance-2.0") ?? null });
    await assert.rejects(adapter.submit(assetSpec({ firstFrame: "https://assets.example.com/f.jpg" }), "k"), EngineError);
    assert.equal(script.requests.length, 0);
  });

  it("classifies an unsupported-value answer from the provider as invalid_input", async () => {
    const script = scripted({ [SUBMIT_PATH]: json(400, fixture("video-400-unsupported.json")) });
    const { gateway, route, profile } = klingAdapter({ transport: script.transport });
    const adapter = openRouterVideoAdapter({ gateway, organizationId: "org_1", route, profile });
    await assert.rejects(adapter.submit(assetSpec(), "k"), (error: unknown) => {
      assert.ok(error instanceof ProviderCallError);
      assert.equal(error.providerError.kind, "invalid_input");
      assert.equal(error.providerError.retryable, false);
      return true;
    });
  });

  it("a rate limit on submit is retryable", async () => {
    const script = scripted({ [SUBMIT_PATH]: json(429, { error: "rate limited" }) });
    const { gateway, route, profile } = klingAdapter({ transport: script.transport });
    const adapter = openRouterVideoAdapter({ gateway, organizationId: "org_1", route, profile });
    const error = await adapter.submit(assetSpec(), "k").then(
      () => null,
      (thrown: unknown) => thrown,
    );
    assert.equal(classifyError(error).kind, "rate_limit");
    assert.equal(classifyError(error).retryable, true);
  });

  it("is not connected without a verified profile, and sends nothing", async () => {
    const script = scripted({});
    const gateway = gatewayFor(script.transport);
    const route = gateway.routes("video.cinematic")[0];
    if (!route) throw new Error("no route");
    const adapter = openRouterVideoAdapter({ gateway, organizationId: "org_1", route, profile: null });
    assert.equal((await adapter.connection("org_1")).connected, false);
    assert.equal(adapter.capabilities.maxSeconds, 0);
    assert.equal(script.requests.length, 0);
  });

  it("is not connected when the OpenRouter key is absent, and sends nothing", async () => {
    const script = scripted({});
    const gateway = createGateway({ transport: script.transport, credentials: staticKeys({}) });
    const route = gateway.routes("video.cinematic")[0];
    if (!route) throw new Error("no route");
    const adapter = openRouterVideoAdapter({ gateway, organizationId: "org_1", route, profile: profiles().get(KLING) ?? null });
    const connection = await adapter.connection("org_1");
    assert.equal(connection.connected, false);
    assert.equal(script.requests.length, 0);
  });
});

describe("OpenRouter video poll", () => {
  it("reports pending while the job runs, and done with the bill and the video URL when it completes", async () => {
    const script = scripted({ [POLL_PATH]: [json(200, fixture("video-poll-in-progress.json")), json(200, fixture("video-poll-completed.json"))] });
    const { gateway, route, profile } = klingAdapter({ transport: script.transport });
    const adapter = openRouterVideoAdapter({ gateway, organizationId: "org_1", route, profile });
    assert.deepEqual(await adapter.poll("job-abc123"), { state: "pending" });
    const done = await adapter.poll("job-abc123");
    assert.equal(done.state, "done");
    assert.equal(done.uri, "https://openrouter.ai/api/v1/videos/job-abc123/content?index=0");
    assert.equal(done.actualUsd, 0.6125);
  });

  it("names a policy refusal as content_policy and any other failure as unknown", async () => {
    const policy = scripted({ [POLL_PATH]: json(200, fixture("video-poll-failed-policy.json")) });
    const first = klingAdapter({ transport: policy.transport });
    const policyPoll = await openRouterVideoAdapter({ gateway: first.gateway, organizationId: "org_1", route: first.route, profile: first.profile }).poll("job-abc123");
    assert.equal(policyPoll.state, "failed");
    assert.equal(policyPoll.error?.kind, "content_policy");
    assert.equal(policyPoll.error?.retryable, false);

    const other = scripted({ [POLL_PATH]: json(200, { id: "job-abc123", status: "failed", error: "frame decode error" }) });
    const second = klingAdapter({ transport: other.transport });
    const otherPoll = await openRouterVideoAdapter({ gateway: second.gateway, organizationId: "org_1", route: second.route, profile: second.profile }).poll("job-abc123");
    assert.equal(otherPoll.error?.kind, "unknown");
  });

  it("refuses a video URL that is not https, so no unusable output is stored", async () => {
    const script = scripted({
      [POLL_PATH]: json(200, { id: "job-abc123", status: "completed", unsigned_urls: ["http://openrouter.ai/api/v1/videos/x"], usage: { cost: 0.6 } }),
    });
    const { gateway, route, profile } = klingAdapter({ transport: script.transport });
    const poll = await openRouterVideoAdapter({ gateway, organizationId: "org_1", route, profile }).poll("job-abc123");
    assert.equal(poll.state, "failed");
    assert.equal(poll.error?.kind, "unknown");
  });

  it("maps a retryable poll error to pending, as the gateway does", async () => {
    const script = scripted({ [POLL_PATH]: json(503, { error: "busy" }) });
    const { gateway, route, profile } = klingAdapter({ transport: script.transport });
    assert.deepEqual(await openRouterVideoAdapter({ gateway, organizationId: "org_1", route, profile }).poll("job-abc123"), { state: "pending" });
  });
});

describe("OpenRouter video price", () => {
  it("prices per second from the table, and refuses a model with no known price", () => {
    const { gateway, route, profile } = klingAdapter();
    const adapter = openRouterVideoAdapter({ gateway, organizationId: "org_1", route, profile });
    assert.equal(adapter.price(assetSpec({ durationMs: 5000 })).estimateUsd, 0.63);
    const pinned = openRouterVideoAdapter({
      gateway,
      organizationId: "org_1",
      route: { ...route, priceKey: "i2v_pinned_model" },
      profile,
    });
    assert.throws(() => pinned.price(assetSpec()), (error: unknown) => error instanceof EngineError && error.kind === "unknown_price");
  });
});
