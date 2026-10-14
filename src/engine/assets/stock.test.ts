import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fixture, gatewayFor, json, scripted } from "./test/recorded.ts";
import { pexelsClips, pexelsStockProvider } from "./providers/pexels.ts";
import { pixabayClips, pixabayStockProvider } from "./providers/pixabay.ts";
import { searchStock } from "./stock.ts";
import { stockProviderFor } from "./providers/index.ts";

const MIN_MS = 5000;

describe("Pexels clips", () => {
  it("keeps the page, the author and the file to fetch, and rejects landscape, short and HLS-only clips", () => {
    const { clips, rejected } = pexelsClips(fixture("pexels-search.json"), MIN_MS);
    assert.equal(clips.length, 1);
    assert.equal(rejected, 2);
    const [clip] = clips;
    assert.equal(clip?.vendor, "pexels");
    assert.equal(clip?.clipId, "4433001");
    assert.equal(clip?.sourceUrl, "https://www.pexels.com/video/coffee-pour-4433001/");
    assert.deepEqual(clip?.author, { name: "Ana Lima", url: "https://www.pexels.com/@ana-lima" });
    assert.equal(clip?.downloadUrl, "https://videos.pexels.com/video-files/4433001/4433001-hd_1080_1920_30fps.mp4");
    assert.equal(clip?.height, 1920);
    assert.equal(clip?.durationMs, 8000);
  });

  it("marks the licence unverified, with no licence page, until the owner checks it (E2.6)", () => {
    const [clip] = pexelsClips(fixture("pexels-search.json"), MIN_MS).clips;
    assert.deepEqual(clip?.licence, { status: "unverified", pageUrl: null });
  });

  it("returns no clips for a body that is not a search answer", () => {
    assert.deepEqual(pexelsClips({ photos: [] }, MIN_MS), { clips: [], rejected: 0 });
  });
});

describe("Pixabay clips", () => {
  it("keeps the page and the author, takes the largest portrait size that fits, and rejects the rest", () => {
    const { clips, rejected } = pixabayClips(fixture("pixabay-search.json"), MIN_MS);
    assert.equal(clips.length, 1);
    assert.equal(rejected, 1);
    const [clip] = clips;
    assert.equal(clip?.sourceUrl, "https://pixabay.com/videos/hands-making-coffee-7781001/");
    assert.deepEqual(clip?.author, { name: "Mara Voss", url: null });
    assert.equal(clip?.downloadUrl, "https://cdn.pixabay.com/video/2026/07/7781001_large.mp4");
    assert.deepEqual(clip?.licence, { status: "unverified", pageUrl: null });
  });
});

describe("stock search", () => {
  it("sends the portrait search through the gateway with the Pexels key, and returns clips with attribution", async () => {
    const script = scripted({ "GET /videos/search": json(200, fixture("pexels-search.json")) });
    const gateway = gatewayFor(script.transport);
    const provider = pexelsStockProvider({ gateway });
    const result = await provider.search("coffee pour", { minDurationMs: MIN_MS, organizationId: "org_1" });
    assert.equal(result.status, "ok");
    const url = new URL(String(script.requests[0]?.url));
    assert.equal(url.origin + url.pathname, "https://api.pexels.com/videos/search");
    assert.equal(url.searchParams.get("query"), "coffee pour");
    assert.equal(url.searchParams.get("orientation"), "portrait");
    assert.equal(script.requests[0]?.headers.Authorization, "pexels-test");
  });

  it("sends the Pixabay search with the key added by the gateway, not by the adapter", async () => {
    const script = scripted({ "GET /api/videos/": json(200, fixture("pixabay-search.json")) });
    const gateway = gatewayFor(script.transport);
    await pixabayStockProvider({ gateway }).search("coffee", { minDurationMs: MIN_MS, organizationId: "org_1" });
    const url = new URL(String(script.requests[0]?.url));
    assert.equal(url.searchParams.get("key"), "pixabay-test");
    assert.equal(url.searchParams.get("safesearch"), "true");
    assert.equal(url.searchParams.get("min_height"), "1920");
  });

  it("falls back to Pixabay when Pexels is rate limited, and keeps the reason", async () => {
    const script = scripted({
      "GET /videos/search": json(429, { error: "rate limited" }),
      "GET /api/videos/": json(200, fixture("pixabay-search.json")),
    });
    const gateway = gatewayFor(script.transport);
    const outcome = await searchStock({
      gateway,
      organizationId: "org_1",
      query: "coffee",
      minDurationMs: MIN_MS,
      providerFor: (route) => stockProviderFor(route, gateway),
    });
    assert.equal(outcome.status, "found");
    if (outcome.status !== "found") return;
    assert.equal(outcome.providerId, "pixabay");
    assert.equal(outcome.clip.author.name, "Mara Voss");
    assert.match(outcome.reasons.join(" "), /pexels: rate_limit/);
  });

  it("reports no_results when no vendor has a clip, and not_connected when no key is set", async () => {
    const empty = scripted({
      "GET /videos/search": json(200, { videos: [] }),
      "GET /api/videos/": json(200, { hits: [] }),
    });
    const gateway = gatewayFor(empty.transport);
    const none = await searchStock({
      gateway,
      organizationId: "org_1",
      query: "nothing",
      minDurationMs: MIN_MS,
      providerFor: (route) => stockProviderFor(route, gateway),
    });
    assert.equal(none.status, "no_results");
    assert.equal(empty.requests.length, 2);

    const keyless = scripted({});
    const noKeys = gatewayFor(keyless.transport, { keys: {} });
    const outcome = await searchStock({
      gateway: noKeys,
      organizationId: "org_1",
      query: "coffee",
      minDurationMs: MIN_MS,
      providerFor: (route) => stockProviderFor(route, noKeys),
    });
    assert.equal(outcome.status, "not_connected");
    assert.equal(keyless.requests.length, 0);
  });
});
