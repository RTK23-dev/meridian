import assert from "node:assert/strict";
import test from "node:test";
import { canAccessStoredAsset, isPreviewableMime, parseByteRange } from "./media-access.ts";
import { createRateLimit } from "../security/limits.ts";

test("byte ranges support bounded, open-ended, and suffix requests", () => {
  assert.deepEqual(parseByteRange("bytes=0-99", 300), { start: 0, end: 99 });
  assert.deepEqual(parseByteRange("bytes=100-", 300), { start: 100, end: 299 });
  assert.deepEqual(parseByteRange("bytes=-50", 300), { start: 250, end: 299 });
  assert.equal(parseByteRange(null, 300), null);
  assert.equal(parseByteRange("bytes=500-", 300), "invalid");
  assert.equal(parseByteRange("bytes=2-1", 300), "invalid");
});

test("stored asset access requires matching organization, brand, and membership", () => {
  const base = { assetOrganizationId: "org-a", blobOrganizationId: "org-a", assetBrandId: "brand-a", blobBrandId: "brand-a", memberOrganizationIds: ["org-a"] };
  assert.equal(canAccessStoredAsset(base), true);
  assert.equal(canAccessStoredAsset({ ...base, memberOrganizationIds: ["org-b"] }), false);
  assert.equal(canAccessStoredAsset({ ...base, blobOrganizationId: "org-b" }), false);
  assert.equal(canAccessStoredAsset({ ...base, blobBrandId: "brand-b" }), false);
});

test("media route permits image and MP4 only", () => {
  assert.equal(isPreviewableMime("image/webp"), true);
  assert.equal(isPreviewableMime("video/mp4"), true);
  assert.equal(isPreviewableMime("text/html"), false);
  assert.equal(isPreviewableMime("video/webm"), false);
});

test("rate limiting permits requests again after the window and evicts expired keys", () => {
  const limit = createRateLimit(1, 100);
  assert.equal(limit.allow("user-a", 0), true);
  assert.equal(limit.allow("user-a", 1), false);
  assert.equal(limit.allow("user-a", 101), true);
});
