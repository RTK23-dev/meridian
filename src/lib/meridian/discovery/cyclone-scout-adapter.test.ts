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
});
