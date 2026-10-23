import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { modelCatalogEntrySchema } from "../contracts/catalog.ts";
import { createGateway } from "./gateway.ts";
import { modelCatalogCache, parseModelsCatalog, parseVideoCatalog, readModelCatalog } from "./catalog.ts";
import { json, recorded, staticKeys } from "./test/recorded.ts";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./test/fixtures/${name}.json`, import.meta.url), "utf8"));
const READ_AT = "2026-10-16T09:00:00.000Z";
const START_MS = Date.parse(READ_AT);

function listings() {
  return [json(200, fixture("openrouter-catalog-videos")), json(200, fixture("openrouter-catalog-image")), json(200, fixture("openrouter-catalog-speech"))];
}

describe("catalog parse: GET /videos/models", () => {
  const parsed = parseVideoCatalog(fixture("openrouter-catalog-videos"), READ_AT);

  it("keeps the rows with a per-second price, preferring the SKU priced at 1080p", () => {
    assert.deepEqual(
      parsed.entries.map((entry) => [entry.id, entry.price.usd, entry.price.sku]),
      [
        ["kwaivgi/kling-v3.0-std", 0.14, "per-video-second-1080p"],
        ["alibaba/wan-2.6", 0.0425, "per-video-second-1080p"],
      ],
    );
    for (const entry of parsed.entries) {
      assert.ok(modelCatalogEntrySchema.safeParse(entry).success, `${entry.id} fits the contract`);
      assert.equal(entry.price.unit, "per_second");
      assert.equal(entry.readAt, READ_AT, "every entry carries the read time");
      assert.deepEqual(entry.modelClasses, ["video.cinematic", "video.budget"], "never video.i2v_pinned, never avatar");
    }
  });

  it("maps the listed capabilities, and leaves unknown ones null", () => {
    const kling = parsed.entries.find((entry) => entry.id === "kwaivgi/kling-v3.0-std");
    assert.deepEqual(kling?.capabilities, {
      minSeconds: 5,
      maxSeconds: 10,
      durationsSeconds: [5, 10],
      aspectRatios: ["9:16", "16:9"],
      resolutions: ["720p", "1080p"],
      firstFrame: true,
      lastFrame: true,
      refsMax: null,
      audio: true,
    });
    const wan = parsed.entries.find((entry) => entry.id === "alibaba/wan-2.6");
    assert.equal(wan?.capabilities.firstFrame, null, "no supported_frame_images: unknown, not false");
    assert.equal(wan?.capabilities.lastFrame, null);
    assert.deepEqual(wan?.capabilities.durationsSeconds, [5], "the listing names the one duration Wan 2.6 takes");
  });

  it("drops rows without a usable price and malformed rows, each with its reason", () => {
    const reasons = new Map(parsed.dropped.map((drop) => [drop.id, drop.reason]));
    assert.match(reasons.get("bytedance/seedance-2.0") ?? "", /no pricing_skus/);
    assert.match(reasons.get("vendor/free-preview") ?? "", /no positive per-second price/);
    assert.match(reasons.get("vendor/per-video-only") ?? "", /no positive per-second price/);
    assert.match(reasons.get("broken/entry") ?? "", /does not match the listing shape/);
    assert.match(reasons.get("google/veo-3.1-lite") ?? "", /retired by owner decision/, "a retired model is dropped with its reason");
    assert.equal(parsed.dropped.filter((drop) => drop.id === null).length, 1, "the row that is not an object is dropped with no id");
    assert.equal(parsed.dropped.length, 6, "five as before, and the retired Veo 3.1 Lite row");
  });

  it("treats a body with no data array as a failed listing", () => {
    const empty = parseVideoCatalog({ models: [] }, READ_AT);
    assert.deepEqual(empty.entries, []);
    assert.deepEqual(empty.dropped, [{ source: "videos", id: null, reason: "the listing has no data array" }]);
  });
});

describe("catalog parse: GET /models for image and speech", () => {
  it("prices image rows per image, then per request, and drops token-only, variable, text-only and malformed rows", () => {
    const parsed = parseModelsCatalog("image", fixture("openrouter-catalog-image"), READ_AT);
    assert.deepEqual(
      parsed.entries.map((entry) => [entry.id, entry.price.unit, entry.price.usd, entry.modelClasses]),
      [
        ["bytedance-seed/seedream-4.5", "per_image", 0.04, ["image.keyframe", "image.edit"]],
        ["vendor/text-to-image-flat", "per_request", 0.02, ["image.keyframe"]],
      ],
    );
    const seedream = parsed.entries[0];
    assert.equal(seedream?.capabilities.firstFrame, true, "an image input means it can start from a picture");
    assert.equal(seedream?.capabilities.refsMax, null, "how many references is not listed");
    assert.equal(parsed.entries[1]?.capabilities.refsMax, 0, "a text-only input takes no reference");
    const reasons = new Map(parsed.dropped.map((drop) => [drop.id, drop.reason]));
    assert.match(reasons.get("google/gemini-image-tokens") ?? "", /per token only/);
    assert.match(reasons.get("vendor/text-only") ?? "", /does not list image as an output/);
    assert.match(reasons.get("vendor/variable-price") ?? "", /no positive price/);
    assert.ok(parsed.dropped.some((drop) => drop.id === null && /listing shape/.test(drop.reason)), "a row whose id is not a string");
    assert.equal(parsed.dropped.length, 4);
  });

  it("prices speech rows per request and drops token-only rows", () => {
    const parsed = parseModelsCatalog("speech", fixture("openrouter-catalog-speech"), READ_AT);
    assert.deepEqual(
      parsed.entries.map((entry) => [entry.id, entry.price.unit, entry.price.usd, entry.modelClasses]),
      [["elevenlabs/eleven-v4", "per_request", 0.003, ["tts"]]],
    );
    assert.equal(parsed.dropped.length, 1);
    assert.match(parsed.dropped[0]?.reason ?? "", /per token only/);
  });
});

describe("readModelCatalog through the gateway", () => {
  it("reads the three listings once each, with the key, and keeps the read time", async () => {
    const transport = recorded(listings());
    const gateway = createGateway({ transport: transport.transport, credentials: staticKeys({ openrouter: "sk-or-test" }) });
    const read = await readModelCatalog(gateway, { organizationId: "org_1", now: () => START_MS });
    assert.equal(read.status, "read");
    if (read.status !== "read") return;
    assert.equal(read.catalog.readAt, READ_AT);
    assert.deepEqual(read.catalog.failed, []);
    assert.equal(read.catalog.entries.length, 5, "2 video (Veo 3.1 Lite is retired), 2 image, 1 speech");
    assert.notEqual(read.catalog.videoListing, null, "the video listing is kept for the video adapters' profiles");
    assert.deepEqual(
      transport.requests.map((request) => `${request.method} ${request.url}`),
      [
        "GET https://openrouter.ai/api/v1/videos/models",
        "GET https://openrouter.ai/api/v1/models?output_modalities=image",
        "GET https://openrouter.ai/api/v1/models?output_modalities=speech",
      ],
    );
    assert.equal(transport.requests[0]?.headers.Authorization, "Bearer sk-or-test");
  });

  it("is NOT_CONNECTED with no key, and sends nothing", async () => {
    const transport = recorded([]);
    const gateway = createGateway({ transport: transport.transport, credentials: staticKeys({}) });
    const read = await readModelCatalog(gateway, { organizationId: "org_1" });
    assert.equal(read.status, "not_connected");
    if (read.status === "not_connected") assert.match(read.reason, /^NOT_CONNECTED/);
    assert.equal(transport.requests.length, 0);
  });

  it("names a listing that failed and keeps the others", async () => {
    const transport = recorded([json(503, { error: "busy" }), json(200, fixture("openrouter-catalog-image")), json(200, { nothing: true })]);
    const gateway = createGateway({ transport: transport.transport, credentials: staticKeys({ openrouter: "sk-or-test" }) });
    const read = await readModelCatalog(gateway, { organizationId: "org_1", now: () => START_MS });
    assert.equal(read.status, "read");
    if (read.status !== "read") return;
    assert.deepEqual(read.catalog.failed.map((failure) => failure.source), ["videos", "speech"]);
    assert.equal(read.catalog.videoListing, null);
    assert.deepEqual(read.catalog.entries.map((entry) => entry.id), ["bytedance-seed/seedream-4.5", "vendor/text-to-image-flat"]);
  });
});

describe("modelCatalogCache", () => {
  it("serves a full read from memory within the TTL, and reads again after it", async () => {
    let now = START_MS;
    const transport = recorded([...listings(), ...listings()]);
    const gateway = createGateway({ transport: transport.transport, credentials: staticKeys({ openrouter: "sk-or-test" }) });
    const cache = modelCatalogCache({ gateway, ttlMs: 60_000, now: () => now });
    const first = await cache.read("org_1");
    now += 59_000;
    const second = await cache.read("org_1");
    assert.equal(second, first, "the same read, with its first read time");
    assert.equal(transport.requests.length, 3);
    now += 2_000;
    const third = await cache.read("org_1");
    assert.equal(transport.requests.length, 6);
    assert.equal(third.status === "read" ? third.catalog.readAt : null, new Date(START_MS + 61_000).toISOString());
  });

  it("does not keep a read with a failed listing", async () => {
    const transport = recorded([json(500, {}), json(200, fixture("openrouter-catalog-image")), json(200, fixture("openrouter-catalog-speech")), ...listings()]);
    const gateway = createGateway({ transport: transport.transport, credentials: staticKeys({ openrouter: "sk-or-test" }) });
    const cache = modelCatalogCache({ gateway, ttlMs: 60_000, now: () => START_MS });
    const partial = await cache.read("org_1");
    assert.equal(partial.status === "read" ? partial.catalog.failed.length : -1, 1);
    const full = await cache.read("org_1");
    assert.equal(full.status === "read" ? full.catalog.failed.length : -1, 0);
    assert.equal(transport.requests.length, 6);
  });

  it("keeps one read per workspace, and shares a read in flight", async () => {
    const transport = recorded([...listings(), ...listings()]);
    const gateway = createGateway({ transport: transport.transport, credentials: staticKeys({ openrouter: "sk-or-test" }) });
    const cache = modelCatalogCache({ gateway, ttlMs: 60_000, now: () => START_MS });
    const [a, b] = await Promise.all([cache.read("org_1"), cache.read("org_1")]);
    assert.equal(a, b);
    await cache.read("org_2");
    assert.equal(transport.requests.length, 6, "one read for org_1, one for org_2");
  });
});
