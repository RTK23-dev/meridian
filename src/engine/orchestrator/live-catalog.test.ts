import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { gatewayFor, json } from "../claude/test/helpers.ts";
import { OPENROUTER_VIDEO_LISTING, MODEL_EXCLUSIONS } from "../config/model-exclusions.ts";
import { endpointOf, mergeListings, ORCHESTRATOR_LISTINGS, readOrchestratorCatalog, rowOf } from "./live-catalog.ts";

const NOW = "2026-10-21T10:00:00.000Z";
const listings = JSON.parse(readFileSync(new URL("./fixtures/openrouter-listings-trimmed-2026-10-20.json", import.meta.url), "utf8")).listings as Record<string, unknown>;
const replies = () => ORCHESTRATOR_LISTINGS.map((listing) => json(200, listings[listing.path]));

describe("the orchestrator's live catalog (the four public listings, read through the gateway)", () => {
  test("the four listings become one catalog, each row with the price its kind is priced from", async () => {
    const { gateway, requests } = gatewayFor(replies());
    const read = await readOrchestratorCatalog(gateway, { organizationId: "org_1", now: () => NOW });
    assert.equal(read.status, "ok");
    if (read.status !== "ok") return;
    const haiku = read.catalog.byId.get("anthropic/claude-haiku-5.5");
    assert.equal(haiku?.kind, "text");
    assert.equal(haiku?.pricing.promptUsdPerToken, 1e-7);
    assert.equal(haiku?.pricing.completionUsdPerToken, 5e-7);
    assert.equal(read.catalog.byId.get("bytedance-seed/seedream-5-0-pro")?.pricing.imageUsd, 0.003);
    assert.equal(read.catalog.byId.get("alibaba/wan-3.0")?.pricing.usdPerSecond1080p, 0.2);
    assert.equal(read.catalog.byId.get("elevenlabs/eleven-multilingual-v2")?.kind, "speech");
    assert.equal(read.catalog.takenAt, NOW);
    assert.deepEqual(requests.map((request) => request.url.replace("https://openrouter.ai/api/v1", "")), ORCHESTRATOR_LISTINGS.map((listing) => listing.path));
  });

  test("a row with no id is dropped with its reason, and the rows around it are kept", async () => {
    const { gateway } = gatewayFor(replies());
    const read = await readOrchestratorCatalog(gateway, { organizationId: "org_1", now: () => NOW });
    if (read.status !== "ok") throw new Error("the fixture catalog must read");
    assert.equal(read.catalog.dropped.length, 1);
    assert.ok(read.catalog.byId.has("anthropic/claude-opus-5.5"));
  });

  test("a model in two listings keeps its most specific kind", () => {
    const text = { data: [{ id: "vendor/both", name: "Both", architecture: { input_modalities: ["text"], output_modalities: ["text"] }, pricing: { prompt: "0.000001", completion: "0.000002" } }] };
    const image = { data: [{ id: "vendor/both", name: "Both", architecture: { input_modalities: ["text"], output_modalities: ["image"] }, pricing: { image: "0.01" } }] };
    const catalog = mergeListings([{ kind: "text", body: text }, { kind: "image", body: image }], NOW);
    assert.equal(catalog.byId.get("vendor/both")?.kind, "image");
    assert.equal(catalog.byId.get("vendor/both")?.pricing.imageUsd, 0.01);
  });

  test("a price the listing does not state is null, never zero", () => {
    const row = rowOf({ id: "vendor/no-price", pricing: {} }, "text");
    assert.deepEqual((row.pricing as Record<string, unknown>).promptUsdPerToken, null);
    assert.deepEqual((row.pricing as Record<string, unknown>).completionUsdPerToken, null);
  });

  test("no connected key: not_connected with the reason, and no listing is read", async () => {
    const { gateway, requests } = gatewayFor([], { keys: {} });
    const read = await readOrchestratorCatalog(gateway, { organizationId: "org_1", now: () => NOW });
    assert.equal(read.status, "not_connected");
    assert.equal(requests.length, 0);
  });

  test("a listing that fails: failed with the reason, and no partial catalog is returned", async () => {
    const { gateway } = gatewayFor([json(500, { error: "unavailable" })]);
    const read = await readOrchestratorCatalog(gateway, { organizationId: "org_1", now: () => NOW });
    assert.equal(read.status, "failed");
    if (read.status === "failed") assert.match(read.reason, /GET \/models failed/);
    assert.equal("catalog" in read, false);
  });
});

describe("model exclusions in the orchestrator's live catalog (config/model-exclusions.ts, one endpoint each)", () => {
  test("each listing is named as its endpoint, the video listing as model-exclusions.ts names it", () => {
    assert.equal(endpointOf("/videos/models"), OPENROUTER_VIDEO_LISTING);
  });

  test("the shipped list is empty, so a live read excludes nothing", async () => {
    assert.deepEqual(MODEL_EXCLUSIONS, []);
    const { gateway } = gatewayFor(replies());
    const read = await readOrchestratorCatalog(gateway, { organizationId: "org_1", now: () => NOW });
    if (read.status !== "ok") throw new Error("the fixture catalog must read");
    assert.deepEqual(read.catalog.excluded, []);
    assert.equal(read.catalog.byId.has("alibaba/wan-3.0"), true);
  });

  test("an exclusion removes a model from the listing it names, with its reason; another listing that lists the model keeps it", () => {
    const text = { data: [{ id: "vendor/both", name: "Both", architecture: { input_modalities: ["text"], output_modalities: ["text"] }, pricing: { prompt: "0.000001", completion: "0.000002" } }] };
    const video = { data: [{ id: "vendor/both", name: "Both", pricing_skus: { duration_seconds_1080p: "0.1" } }] };
    const exclusions = [{ endpoint: OPENROUTER_VIDEO_LISTING, model: "vendor/both", reason: "test: the video listing refused it on the check's date" }];
    const catalog = mergeListings(
      [
        { kind: "text", body: text, endpoint: endpointOf("/models") },
        { kind: "video", body: video, endpoint: endpointOf("/videos/models") },
      ],
      NOW,
      exclusions,
    );
    assert.equal(catalog.byId.get("vendor/both")?.kind, "text", "the text listing still lists it, so it stays eligible there");
    assert.deepEqual(catalog.excluded, [{ id: "vendor/both", endpoint: OPENROUTER_VIDEO_LISTING, reason: "test: the video listing refused it on the check's date" }]);
    assert.equal(catalog.dropped.length, 0, "an exclusion is not a parse failure");
  });

  test("the live read applies the exclusions it is given to the listing each one names", async () => {
    const { gateway } = gatewayFor(replies());
    const reason = "test: refused on the video listing";
    const read = await readOrchestratorCatalog(gateway, {
      organizationId: "org_1",
      now: () => NOW,
      exclusions: [{ endpoint: OPENROUTER_VIDEO_LISTING, model: "alibaba/wan-3.0", reason }],
    });
    if (read.status !== "ok") throw new Error("the fixture catalog must read");
    assert.equal(read.catalog.byId.has("alibaba/wan-3.0"), false, "the excluded model is not in the catalog the orchestrator chooses from");
    assert.equal(read.catalog.byId.has("kwaivgi/kling-v3.0-std"), true, "the other video models are kept");
    assert.deepEqual(read.catalog.excluded, [{ id: "alibaba/wan-3.0", endpoint: OPENROUTER_VIDEO_LISTING, reason }]);
  });
});
