import assert from "node:assert/strict";
import test from "node:test";
import {
  CycloneScoutSourceAdapter,
  parseMetricNumber,
  type CyclonePageCard,
} from "./cyclone-scout-adapter.ts";

test("parseMetricNumber correctly parses abbreviated counts", () => {
  assert.equal(parseMetricNumber("1.2M views"), 1200000);
  assert.equal(parseMetricNumber("450K plays"), 450000);
  assert.equal(parseMetricNumber("12,400 likes"), 12400);
  assert.equal(parseMetricNumber("350 comments"), 350);
});

test("CycloneScoutSourceAdapter reports NOT_CONNECTED when gateway or device is unconfigured", async () => {
  const adapter = new CycloneScoutSourceAdapter({ config: { gatewayUrl: "", deviceId: "" } });
  const check = await adapter.checkConnection();
  assert.equal(check.connected, false);
});

test("CycloneScoutSourceAdapter parses accessibility Page Card into DiscoveredReelItem", () => {
  const adapter = new CycloneScoutSourceAdapter({
    config: { gatewayUrl: "http://127.0.0.1:9090", deviceId: "pixel-8-pro-01" },
  });

  const sampleCard: CyclonePageCard = {
    nodeId: "root_view",
    role: "FrameLayout",
    children: [
      {
        nodeId: "header",
        role: "ViewGroup",
        children: [
          { nodeId: "creator", role: "TextView", text: "@marcus_fitness" },
          { nodeId: "audio", role: "TextView", text: "audio-synthwave-trend • Trending" },
        ],
      },
      {
        nodeId: "metrics",
        role: "ViewGroup",
        children: [
          { nodeId: "views_node", role: "TextView", text: "2.5M views" },
          { nodeId: "likes_node", role: "TextView", text: "140K likes" },
          { nodeId: "comments_node", role: "TextView", text: "3.2K comments" },
        ],
      },
      {
        nodeId: "link_node",
        role: "TextView",
        text: "https://www.instagram.com/reel/DC_test123/",
      },
    ],
  };

  const item = adapter.parsePageCardToReel(sampleCard, "fitness");
  assert.ok(item !== null);
  if (!item) return;

  assert.equal(item.creatorHandle, "marcus_fitness");
  assert.equal(item.metrics.views, 2500000);
  assert.equal(item.metrics.likes, 140000);
  assert.equal(item.metrics.comments, 3200);
  assert.equal(item.audio.isTrending, true);
  assert.equal(item.discoveryTier, "cyclone_scout");
  assert.equal(item.scoutDeviceId, "pixel-8-pro-01");
  assert.equal(item.permalink, "https://www.instagram.com/reel/DC_test123/");
  assert.equal(item.externalPostId, "DC_test123");
});

test("CycloneScoutSourceAdapter enforces zero fabrication when permalink, date, and views are not visible", () => {
  const adapter = new CycloneScoutSourceAdapter({
    config: { gatewayUrl: "http://127.0.0.1:9090", deviceId: "pixel-8-pro-02" },
  });

  const cardWithoutLinkOrViews: CyclonePageCard = {
    nodeId: "root_view",
    role: "FrameLayout",
    children: [
      {
        nodeId: "header",
        role: "ViewGroup",
        children: [
          { nodeId: "creator", role: "TextView", text: "@raw_creator" },
          { nodeId: "audio", role: "TextView", text: "Original sound" },
        ],
      },
      {
        nodeId: "metrics",
        role: "ViewGroup",
        children: [
          { nodeId: "likes_node", role: "TextView", text: "500 likes" },
        ],
      },
    ],
  };

  const item = adapter.parsePageCardToReel(cardWithoutLinkOrViews, "skincare");
  assert.ok(item !== null);
  if (!item) return;

  // Zero fabrication asserts:
  assert.equal(item.permalink, undefined);
  assert.equal(item.externalPostId, undefined);
  assert.equal(item.postedAt, undefined);
  assert.equal(item.metrics.views, undefined);
  assert.equal(item.metrics.likes, 500);
  assert.ok(item.id.startsWith("scout-pixel-8-pro-02-"));
});

test("CycloneScoutSourceAdapter calls /v1/capabilities/observe and preserves session provenance", async () => {
  let observedUrl = "";
  let observedBody: any = null;
  let observedHeaders: any = null;

  const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    observedUrl = String(url);
    observedHeaders = init?.headers;
    observedBody = JSON.parse(String(init?.body || "{}"));

    return {
      ok: true,
      status: 200,
      json: async () => ({
        session_id: "test-session-123",
        observed_at: "2026-10-09T09:00:00.000Z",
        screenshot_url: "http://127.0.0.1:4000/screenshots/shot1.webp",
        screenshot_id: "cyclone-art-99",
        page_card: {
          nodeId: "root",
          role: "FrameLayout",
          children: [
            { nodeId: "c1", role: "TextView", text: "@fitness_pro" },
            { nodeId: "c2", role: "TextView", text: "50K plays" },
            { nodeId: "c3", role: "TextView", text: "1.2K likes" },
          ],
        },
      }),
    } as any;
  }) as typeof fetch;

  const adapter = new CycloneScoutSourceAdapter({
    config: { gatewayUrl: "http://127.0.0.1:4000", deviceId: "pixel-8-pro-01", apiKey: "sec-key" },
    fetchFn: mockFetch,
  });

  const reels = await adapter.observeFeed({
    niche: "fitness",
    budget: 3,
    sessionId: "test-session-123",
  });

  assert.equal(observedUrl, "http://127.0.0.1:4000/v1/capabilities/observe");
  assert.equal(observedBody.device_id, "pixel-8-pro-01");
  assert.equal(observedBody.session_id, "test-session-123");
  assert.equal(observedBody.mode, "compact");
  assert.equal(observedBody.include_screenshot, true);
  assert.equal(observedHeaders["X-Cyclone-Protocol"], "cyclone.gateway.capability.v1");
  assert.equal(observedHeaders["Authorization"], "Bearer sec-key");

  assert.equal(reels.length, 1);
  const reel = reels[0];
  assert.equal(reel.creatorHandle, "fitness_pro");
  assert.equal(reel.scoutDeviceId, "pixel-8-pro-01");
  assert.equal(reel.scoutSessionId, "test-session-123");
  assert.equal(reel.scoutObservationTime, "2026-10-09T09:00:00.000Z");
  assert.equal(reel.screenshotUrl, "http://127.0.0.1:4000/screenshots/shot1.webp");
  assert.equal(reel.screenshotArtifactId, "cyclone-art-99");
});

test("CycloneScoutSourceAdapter checks /v1/device/status and fails if device is unregistered", async () => {
  const mockFetch = (async (url: string | URL | Request) => {
    const urlStr = String(url);
    if (urlStr.includes("/v1/device/status")) {
      return { ok: false, status: 404 } as any;
    }
    if (urlStr.includes("/v1/devices")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          devices: [{ deviceId: "other-phone-01", status: "ready" }],
        }),
      } as any;
    }
    return { ok: true, status: 200, json: async () => ({ status: "ok" }) } as any;
  }) as typeof fetch;

  const adapter = new CycloneScoutSourceAdapter({
    config: { gatewayUrl: "http://127.0.0.1:4000", deviceId: "pixel-8-pro-missing" },
    fetchFn: mockFetch,
  });

  const check = await adapter.checkConnection();
  assert.equal(check.connected, false);
  assert.match(check.reason || "", /not registered/i);
});
