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

// Tidy-up review (Cyclone): each test below states a behaviour the adapter must have. They were written against the code as it was, and
// the ones that failed were the bugs they name.

function gatewayAnswering(routes: Record<string, { status: number; body?: unknown; delayMs?: number }>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    const route = routes[path];
    if (!route) return { ok: false, status: 404, json: async () => ({}) } as any;
    if (route.delayMs) await new Promise((resolve) => setTimeout(resolve, route.delayMs));
    return { ok: route.status >= 200 && route.status < 300, status: route.status, json: async () => route.body ?? {} } as any;
  }) as typeof fetch;
}

test("a gateway that only answers /v1/capabilities is NOT connected: the target device was never seen (no fake success)", async () => {
  const adapter = new CycloneScoutSourceAdapter({
    config: { gatewayUrl: "http://127.0.0.1:4000", deviceId: "pixel-8-pro-01" },
    fetchFn: gatewayAnswering({ "/v1/capabilities": { status: 200, body: { capabilities: ["observe"] } } }),
  });
  const check = await adapter.checkConnection();
  assert.equal(check.connected, false, "a capability list says nothing about this device");
  assert.match(check.reason || "", /device/i);
  assert.equal((await adapter.health()).status, "UNAVAILABLE");
});

test("health reports the time the check took, not a fixed number", async () => {
  const adapter = new CycloneScoutSourceAdapter({
    config: { gatewayUrl: "http://127.0.0.1:4000", deviceId: "pixel-8-pro-01" },
    fetchFn: gatewayAnswering({ "/v1/device/status": { status: 200, body: { status: "ready" }, delayMs: 40 } }),
  });
  const health = await adapter.health();
  assert.equal(health.status, "HEALTHY");
  assert.ok(health.latencyMs >= 30, `latency ${health.latencyMs} ms is measured, not invented`);
});

test("a gateway that never answers is given up on, so a discovery run is not held open", async () => {
  const hangs = (async (_url: string | URL | Request, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as typeof fetch;
  const adapter = new CycloneScoutSourceAdapter({
    config: { gatewayUrl: "http://127.0.0.1:4000", deviceId: "pixel-8-pro-01" },
    fetchFn: hangs,
    timeoutMs: 50,
  });
  const started = Date.now();
  // The timeout timer is unref'd, so keep the event loop alive for the wait, as a running server does.
  const keepAlive = setTimeout(() => undefined, 5000);
  try {
    const check = await adapter.checkConnection();
    assert.equal(check.connected, false);
    assert.ok(Date.now() - started < 2000, "the check stops at its timeout");
  } finally {
    clearTimeout(keepAlive);
  }
});

test("the audio's first-seen time is the time the screen was observed, never the time the code ran", () => {
  const adapter = new CycloneScoutSourceAdapter({ config: { gatewayUrl: "http://127.0.0.1:4000", deviceId: "pixel-8-pro-01" } });
  const card: CyclonePageCard = { nodeId: "n", role: "reel", children: [{ nodeId: "a", role: "text", text: "audio-trend-123" }, { nodeId: "b", role: "text", text: "@creator" }] };
  const reel = adapter.parsePageCardToReel(card, "skincare", { observedAt: "2026-01-02T03:04:05.000Z" });
  assert.equal(reel?.audio.firstSeenAt, "2026-01-02T03:04:05.000Z");
});

test("evidence availability says only what was observed: a page with no permalink and no metrics is not full evidence", async () => {
  const bare = { session_id: "s2", observed_at: "2026-01-02T03:04:05.000Z", page_cards: [{ nodeId: "n", role: "reel", children: [{ nodeId: "a", role: "text", text: "@creator" }, { nodeId: "b", role: "text", text: "Some caption" }] }] };
  const adapter = new CycloneScoutSourceAdapter({
    config: { gatewayUrl: "http://127.0.0.1:4000", deviceId: "pixel-8-pro-01" },
    fetchFn: gatewayAnswering({ "/v1/capabilities/observe": { status: 200, body: bare } }),
  });
  const [ref] = await adapter.discover({ niche: "skincare", limit: 5 } as any);
  // Cyclone captures on-screen text and a screenshot, never the video file, so it can never claim full evidence.
  assert.notEqual(ref?.evidenceAvailability, "FULL_EVIDENCE_AVAILABLE");
  assert.equal(ref?.evidenceAvailability, "METADATA_AVAILABLE", "the caption and creator were observed");
});

test("the evidence Cyclone sees is kept with the reference: the screenshot survives discovery, and an unsafe address is dropped", async () => {
  const body = {
    session_id: "s1",
    observed_at: "2026-01-02T03:04:05.000Z",
    screenshot_url: "https://gateway.example.com/shots/1.png",
    page_cards: [{ nodeId: "a", role: "reel", children: [{ nodeId: "t", role: "text", text: "Hello" }] }],
  };
  const adapter = new CycloneScoutSourceAdapter({
    config: { gatewayUrl: "http://127.0.0.1:4000", deviceId: "pixel-8-pro-01" },
    fetchFn: gatewayAnswering({ "/v1/capabilities/observe": { status: 200, body } }),
  });
  const refs = await adapter.discover({ niche: "skincare", limit: 5 } as any);
  assert.equal(refs.length, 1);
  assert.equal((refs[0]?.metadata as any)?.screenshotUrl, "https://gateway.example.com/shots/1.png");

  const unsafe = { ...body, screenshot_url: "javascript:alert(1)" };
  const adapterUnsafe = new CycloneScoutSourceAdapter({
    config: { gatewayUrl: "http://127.0.0.1:4000", deviceId: "pixel-8-pro-01" },
    fetchFn: gatewayAnswering({ "/v1/capabilities/observe": { status: 200, body: unsafe } }),
  });
  const [unsafeRef] = await adapterUnsafe.discover({ niche: "skincare", limit: 5 } as any);
  assert.equal((unsafeRef?.metadata as any)?.screenshotUrl, undefined, "a non-web address from the device is never stored");
});
