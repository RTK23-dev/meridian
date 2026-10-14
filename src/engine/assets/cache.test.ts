import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryAssetCache, type CachedAsset } from "./cache.ts";

function asset(overrides: Partial<CachedAsset> = {}): CachedAsset {
  return {
    workspaceId: "org_1",
    cacheKey: "sha256:0000000000000000000000000000000000000000000000000000000000000001",
    providerId: "openrouter:kwaivgi/kling-v3.0-std",
    modelClass: "video.cinematic",
    uri: "https://openrouter.ai/api/v1/videos/job-1/content?index=0",
    costUsd: 0.63,
    mediaType: null,
    storedAt: "2026-10-14T10:00:00.000Z",
    ...overrides,
  };
}

describe("asset cache", () => {
  it("returns a stored asset for the same workspace and key", async () => {
    const cache = memoryAssetCache();
    await cache.put(asset());
    const hit = await cache.get("org_1", asset().cacheKey);
    assert.equal(hit?.uri, asset().uri);
    assert.equal(hit?.costUsd, 0.63);
  });

  it("never returns another workspace's asset for the same key", async () => {
    const cache = memoryAssetCache();
    await cache.put(asset());
    assert.equal(await cache.get("org_2", asset().cacheKey), null);
  });

  it("keeps the first write (artifacts are immutable)", async () => {
    const cache = memoryAssetCache();
    await cache.put(asset());
    const second = await cache.put(asset({ uri: "https://example.com/other.mp4" }));
    assert.equal(second.uri, asset().uri);
    assert.equal((await cache.get("org_1", asset().cacheKey))?.uri, asset().uri);
  });

  it("records hits per workspace", async () => {
    const cache = memoryAssetCache();
    await cache.recordHit({
      workspaceId: "org_1",
      cacheKey: asset().cacheKey,
      providerId: asset().providerId,
      requestId: "req_1",
      shotId: "shot_1",
      at: "2026-10-14T10:05:00.000Z",
      savedUsd: 0.63,
    });
    assert.equal((await cache.hits("org_1")).length, 1);
    assert.equal((await cache.hits("org_2")).length, 0);
  });
});
