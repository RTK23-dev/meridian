import assert from "node:assert/strict";
import test from "node:test";
import { InstagramReelsChannel } from "./instagram.ts";
import { YouTubeShortsChannel } from "./youtube.ts";
import { publishToSelectedChannels, listDistributionChannels } from "./registry.ts";

// Test-provider publishing is restricted to the testing runtime.
process.env.MERIDIAN_TESTING_RUNTIME = "true";

test("registry discovers all built-in organic channels", () => {
  const channels = listDistributionChannels();
  assert.ok(channels.length >= 3);
  assert.ok(channels.some((c) => c.platform === "instagram"));
  assert.ok(channels.some((c) => c.platform === "facebook"));
  assert.ok(channels.some((c) => c.platform === "youtube"));
});

test("instagram rejects invalid MIME types", async () => {
  const ig = new InstagramReelsChannel();
  const receipt = await ig.publish({
    brandId: "brand-1",
    organizationId: "org-1",
    mediaBytes: new Uint8Array([1, 2, 3]),
    mimeType: "text/plain",
    caption: "test caption",
    aspectRatio: "9:16",
    allowTestProvider: true,
  });
  assert.equal(receipt.status, "failed");
  assert.match(receipt.error || "", /Unsupported MIME type/);
});

test("instagram mock publish succeeds with allowTestProvider", async () => {
  const ig = new InstagramReelsChannel();
  const receipt = await ig.publish({
    brandId: "brand-1",
    organizationId: "org-1",
    mediaBytes: new Uint8Array([1, 2, 3, 4]),
    mimeType: "video/mp4",
    caption: "Viral reel",
    aspectRatio: "9:16",
    allowTestProvider: true,
  });
  assert.equal(receipt.status, "published");
  assert.equal(receipt.platform, "instagram");
  assert.ok(receipt.externalId.startsWith("ig_test_"));
  assert.ok(receipt.postUrl?.includes("instagram.com/reel/"));
});

test("youtube shorts generates shorts URL for 9:16 aspect ratio", async () => {
  const yt = new YouTubeShortsChannel();
  const receipt = await yt.publish({
    brandId: "brand-1",
    organizationId: "org-1",
    mediaBytes: new Uint8Array([1, 2, 3, 4]),
    mimeType: "video/mp4",
    caption: "Shorts test #shorts",
    aspectRatio: "9:16",
    allowTestProvider: true,
  });
  assert.equal(receipt.status, "published");
  assert.equal(receipt.platform, "youtube");
  assert.ok(receipt.postUrl?.includes("/shorts/"));
});

test("selective publishing dispatches only to requested channels", async () => {
  const selected = ["instagram-reels", "youtube-shorts"];
  const results = await publishToSelectedChannels({
    selectedChannelIds: selected,
    request: {
      brandId: "brand-1",
      organizationId: "org-1",
      mediaBytes: new Uint8Array([1, 2, 3, 4, 5]),
      mimeType: "video/mp4",
      caption: "Selective test",
      aspectRatio: "9:16",
      allowTestProvider: true,
    },
  });

  assert.equal(results.length, 2);
  assert.equal(results[0]?.channelId, "instagram-reels");
  assert.equal(results[0]?.receipt.status, "published");
  assert.equal(results[1]?.channelId, "youtube-shorts");
  assert.equal(results[1]?.receipt.status, "published");

  // Facebook should not have been called because user did not select it
  assert.ok(!results.some((r) => r.channelId === "facebook-pages"));
});

test("distribution service lists both paid and organic channels", async () => {
  const { listAvailableChannels } = await import("./service.ts");
  const dummySql = (async () => []) as any;
  dummySql.query = async () => [];

  const channels = await listAvailableChannels(dummySql, "org-1", "brand-1");
  assert.ok(channels.length >= 6);
  assert.ok(channels.some((c) => c.id === "test-publisher" && c.type === "paid"));
  assert.ok(channels.some((c) => c.id === "instagram-reels" && c.type === "organic"));
  assert.ok(channels.some((c) => c.id === "youtube-shorts" && c.type === "organic"));
  assert.ok(channels.some((c) => c.id === "meta-ads" && c.type === "paid"));
});
