import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { isEngineMediaKey } from "./engine-media-link.ts";
import { engineAssetKey, engineAssetMediaFor, type EngineAssetObjects } from "./engine-asset-media.ts";

const ORG = "org_a";
const REQUEST = "req_1";
const BRAND = "brand_a";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

function hashOf(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** An in-memory object store with the adapter's shape. It records every read, so a test sees when the store was reached. */
function fakeObjects() {
  const stored = new Map<string, { mimeType: string; bytes: Uint8Array }>();
  const gets: string[] = [];
  const objects: EngineAssetObjects & { stored: typeof stored; gets: string[] } = {
    stored,
    gets,
    async put(input) {
      stored.set(`${input.organizationId}|${input.brandId}|${input.key}`, { mimeType: input.mimeType, bytes: input.bytes });
      return {};
    },
    async get(organizationId, brandId, key) {
      gets.push(`${organizationId}|${brandId}|${key}`);
      const found = stored.get(`${organizationId}|${brandId}|${key}`);
      return found ? { bytes: found.bytes, mimeType: found.mimeType } : null;
    },
  };
  return objects;
}

function storeFor(objects: EngineAssetObjects, brandOf: () => Promise<string> = async () => BRAND) {
  return engineAssetMediaFor({ objects, brandOf }, { organizationId: ORG, requestId: REQUEST });
}

test("an image is stored under its request's brand, at an engine key of its organization, and the key links for that organization only", async () => {
  const objects = fakeObjects();
  const written = await storeFor(objects).put({ workspaceId: ORG, bytes: PNG, mediaType: "image/png", contentHash: hashOf(PNG) });
  const digest = hashOf(PNG).slice("sha256:".length);
  assert.equal(written.uri, `engine/${ORG}/${REQUEST}/assets/${digest}.png`);
  assert.equal(isEngineMediaKey(ORG, written.uri), true);
  assert.equal(isEngineMediaKey("org_b", written.uri), false, "another organization cannot link it");
  assert.equal(objects.stored.get(`${ORG}|${BRAND}|${written.uri}`)?.mimeType, "image/png");
});

test("the same bytes under the same request are one key, so a repeat put names the same object", async () => {
  const objects = fakeObjects();
  const store = storeFor(objects);
  const first = await store.put({ workspaceId: ORG, bytes: PNG, mediaType: "image/png", contentHash: hashOf(PNG) });
  const second = await store.put({ workspaceId: ORG, bytes: PNG, mediaType: "image/png", contentHash: hashOf(PNG) });
  assert.equal(second.uri, first.uri);
  assert.equal(objects.stored.size, 1);
});

test("a write for another workspace is refused, and nothing is stored", async () => {
  const objects = fakeObjects();
  await assert.rejects(
    storeFor(objects).put({ workspaceId: "org_b", bytes: PNG, mediaType: "image/png", contentHash: hashOf(PNG) }),
    /another workspace/,
  );
  assert.equal(objects.stored.size, 0);
});

test("a read of a key outside the workspace is refused before the object store is reached", async () => {
  const objects = fakeObjects();
  const store = storeFor(objects);
  const written = await store.put({ workspaceId: ORG, bytes: PNG, mediaType: "image/png", contentHash: hashOf(PNG) });
  await assert.rejects(store.read({ workspaceId: "org_b", uri: written.uri }), /outside its workspace/);
  assert.equal(objects.gets.length, 0, "the store is never read for another workspace's key");
});

test("a read of the workspace's own key returns the stored bytes and their type", async () => {
  const objects = fakeObjects();
  const store = storeFor(objects);
  const written = await store.put({ workspaceId: ORG, bytes: PNG, mediaType: "image/png", contentHash: hashOf(PNG) });
  const read = await store.read({ workspaceId: ORG, uri: written.uri });
  assert.deepEqual(read?.bytes, PNG);
  assert.equal(read?.mediaType, "image/png");
  assert.equal(await store.read({ workspaceId: ORG, uri: `engine/${ORG}/${REQUEST}/assets/${"0".repeat(64)}.png` }), null);
});

test("bytes that do not match their content hash, an empty file and a type the engine does not store are refused", async () => {
  const objects = fakeObjects();
  const store = storeFor(objects);
  await assert.rejects(store.put({ workspaceId: ORG, bytes: PNG, mediaType: "image/png", contentHash: `sha256:${"0".repeat(64)}` }), /content hash/);
  await assert.rejects(store.put({ workspaceId: ORG, bytes: PNG, mediaType: "audio/mpeg", contentHash: hashOf(PNG) }), /audio\/mpeg/);
  const empty = new Uint8Array(0);
  await assert.rejects(store.put({ workspaceId: ORG, bytes: empty, mediaType: "image/png", contentHash: hashOf(empty) }), /empty/);
  assert.equal(objects.stored.size, 0);
});

test("a request with no brand stores nothing: the brand lookup refuses first", async () => {
  const objects = fakeObjects();
  const store = storeFor(objects, async () => {
    throw new Error("the request has no brand");
  });
  await assert.rejects(store.put({ workspaceId: ORG, bytes: PNG, mediaType: "image/png", contentHash: hashOf(PNG) }), /no brand/);
  assert.equal(objects.stored.size, 0);
});

test("a key part the engine does not allow (a path step) is refused when the key is built", () => {
  assert.throws(() => engineAssetKey({ organizationId: ORG, requestId: "../escape" }, "a".repeat(64), "png"), /part/);
  assert.throws(() => engineAssetKey({ organizationId: "org/x", requestId: REQUEST }, "a".repeat(64), "png"), /part/);
});
