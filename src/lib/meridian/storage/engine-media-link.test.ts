import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestDatabase, seedWorkspace, type TestDatabase } from "../../../engine/test/pg-test-db.ts";
import {
  ENGINE_MEDIA_PATH,
  engineMediaLinkSigner,
  isEngineMediaKey,
  isKitMediaKey,
  isLinkableMediaKey,
  kitKeyParts,
  serveEngineMedia,
  verifyEngineMediaLink,
  type EngineObjectStore,
} from "./engine-media-link.ts";
import { MEDIA_LINK_TTL_SECONDS } from "./media-link.ts";

const SECRET = "x".repeat(40);
const ORIGIN = "https://meridian.example.com";
const NOW = 1_800_000_000;
const ORG_A = "org_engine_a";
const ORG_B = "org_engine_b";
const REQ_A = "req_engine_a";
const KEY_A = `engine/${ORG_A}/${REQ_A}/render/vid_01.mp4`;
const BYTES = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
/** A kit image (Bible 13): the character sheet of a page's character, stored under the organization's brand. */
const KIT_A = `kits/${ORG_A}/brand_a/character/char_1/sheet-1.png`;
const KIT_B = `kits/${ORG_B}/brand_b/character/char_1/sheet-1.png`;
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

let db: TestDatabase;

before(async () => {
  db = await createTestDatabase();
  await seedWorkspace(db.sql, ORG_A, "brand_a");
  await seedWorkspace(db.sql, ORG_B, "brand_b");
  await db.sql`
    insert into engine_requests (id, organization_id, brand_id, format_id, priority, status, state)
    values (${REQ_A}, ${ORG_A}, 'brand_a', 'fmt_engine', 'normal', 'running', '{}')
  `;
});

after(async () => {
  await db.close();
});

/** An object store that holds one object under its brand, and records the lookups it was asked for. */
function storeWith(objects: Record<string, { bytes: Uint8Array; mimeType: string }>): EngineObjectStore & { lookups: string[] } {
  const lookups: string[] = [];
  return {
    lookups,
    async get(organizationId, brandId, key) {
      lookups.push(`${organizationId}/${brandId}/${key}`);
      return objects[`${organizationId}/${brandId}/${key}`] ?? null;
    },
  };
}

async function link(input: { organizationId: string; key: string; nowSeconds?: number }): Promise<string> {
  const signer = engineMediaLinkSigner({ secret: () => SECRET, origin: () => ORIGIN, nowSeconds: () => input.nowSeconds ?? NOW });
  const result = await signer.sign(input.organizationId, input.key, MEDIA_LINK_TTL_SECONDS);
  if (result.status !== "ok") throw new Error("expected a signed link");
  return result.url;
}

test("isEngineMediaKey accepts an engine media key of its own organization only", () => {
  assert.equal(isEngineMediaKey(ORG_A, KEY_A), true);
  assert.equal(isEngineMediaKey(ORG_B, KEY_A), false, "another organization's key is refused");
  assert.equal(isEngineMediaKey(ORG_A, `engine/${ORG_A}/${REQ_A}/render/vid_01.json`), false, "a JSON artifact is not media");
  assert.equal(isEngineMediaKey(ORG_A, `engine/${ORG_A}/${REQ_A}/../vid_01.mp4`), false, "a dot-dot path is refused");
  assert.equal(isEngineMediaKey(ORG_A, `creative/${ORG_A}/${REQ_A}/render/vid_01.mp4`), false);
});

test("the signer fails closed without the secret or the public origin, and names the setting", async () => {
  const noSecret = engineMediaLinkSigner({ secret: () => null, origin: () => ORIGIN, nowSeconds: () => NOW });
  const noSecretResult = await noSecret.sign(ORG_A, KEY_A, MEDIA_LINK_TTL_SECONDS);
  assert.equal(noSecretResult.status, "not_connected");
  assert.match(noSecretResult.status === "not_connected" ? noSecretResult.reason : "", /MEDIA_LINK_SECRET/);

  const noOrigin = engineMediaLinkSigner({ secret: () => SECRET, origin: () => null, nowSeconds: () => NOW });
  const noOriginResult = await noOrigin.sign(ORG_A, KEY_A, MEDIA_LINK_TTL_SECONDS);
  assert.equal(noOriginResult.status, "not_connected");
  assert.match(noOriginResult.status === "not_connected" ? noOriginResult.reason : "", /APP_URL or PUBLIC_APP_URL/);
});

test("the signer throws for a link longer than the 15-minute policy (a programming error, not a refusal)", async () => {
  const signer = engineMediaLinkSigner({ secret: () => SECRET, origin: () => ORIGIN, nowSeconds: () => NOW });
  await assert.rejects(() => signer.sign(ORG_A, KEY_A, MEDIA_LINK_TTL_SECONDS + 1), /1 to 900 seconds/);
});

test("the signer refuses a key that is not an engine media key of its organization, and signs nothing for it", async () => {
  const signer = engineMediaLinkSigner({ secret: () => SECRET, origin: () => ORIGIN, nowSeconds: () => NOW });
  const otherOrg = await signer.sign(ORG_A, `engine/${ORG_B}/${REQ_A}/render/vid_01.mp4`, MEDIA_LINK_TTL_SECONDS);
  assert.equal(otherOrg.status, "refused");
  assert.equal("url" in otherOrg, false, "no URL is returned for a refused key");
  const external = await signer.sign(ORG_A, "https://cdn.example.com/stock/clip.mp4", MEDIA_LINK_TTL_SECONDS);
  assert.equal(external.status, "refused", "an external URL is not an engine object, so it is not re-signed");
});

test("a signed link names the organization, the key and an expiry 15 minutes ahead, on the https origin", async () => {
  const url = new URL(await link({ organizationId: ORG_A, key: KEY_A }));
  assert.equal(url.origin, ORIGIN);
  assert.equal(url.pathname, ENGINE_MEDIA_PATH);
  assert.equal(url.searchParams.get("org"), ORG_A);
  assert.equal(url.searchParams.get("key"), KEY_A);
  assert.equal(Number(url.searchParams.get("expires")), NOW + 15 * 60);
  assert.match(url.searchParams.get("sig") ?? "", /^[0-9a-f]{64}$/);
});

test("a link verifies before its expiry and not at or after it, and not for another organization or key", async () => {
  const url = new URL(await link({ organizationId: ORG_A, key: KEY_A }));
  const expires = url.searchParams.get("expires");
  const sig = url.searchParams.get("sig");
  const base = { secret: SECRET, expires, sig };
  assert.equal(verifyEngineMediaLink({ ...base, organizationId: ORG_A, objectKey: KEY_A, nowSeconds: NOW + 60 }), "ok");
  assert.equal(verifyEngineMediaLink({ ...base, organizationId: ORG_A, objectKey: KEY_A, nowSeconds: NOW + 15 * 60 }), "expired");
  assert.equal(verifyEngineMediaLink({ ...base, organizationId: ORG_B, objectKey: KEY_A, nowSeconds: NOW + 60 }), "bad_signature");
  assert.equal(verifyEngineMediaLink({ ...base, organizationId: ORG_A, objectKey: `${KEY_A}x`, nowSeconds: NOW + 60 }), "bad_signature");
  assert.equal(verifyEngineMediaLink({ ...base, secret: "y".repeat(40), organizationId: ORG_A, objectKey: KEY_A, nowSeconds: NOW + 60 }), "bad_signature");
  assert.equal(verifyEngineMediaLink({ ...base, sig: "nothex", organizationId: ORG_A, objectKey: KEY_A, nowSeconds: NOW + 60 }), "malformed");
});

test("the route serves a verified object for the organization its request belongs to", async () => {
  const store = storeWith({ [`${ORG_A}/brand_a/${KEY_A}`]: { bytes: BYTES, mimeType: "video/mp4" } });
  const url = await link({ organizationId: ORG_A, key: KEY_A });
  const response = await serveEngineMedia({
    request: new Request(url),
    getSql: async () => db.sql,
    objectStore: () => store,
    secret: SECRET,
    nowSeconds: () => NOW + 60,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), BYTES);
  assert.deepEqual(store.lookups, [`${ORG_A}/brand_a/${KEY_A}`]);
});

test("the route refuses an expired link, a forged one, and reads nothing for either", async () => {
  const store = storeWith({ [`${ORG_A}/brand_a/${KEY_A}`]: { bytes: BYTES, mimeType: "video/mp4" } });
  const url = await link({ organizationId: ORG_A, key: KEY_A });
  const expired = await serveEngineMedia({ request: new Request(url), getSql: async () => db.sql, objectStore: () => store, secret: SECRET, nowSeconds: () => NOW + 15 * 60 });
  assert.equal(expired.status, 403);
  const forged = new URL(url);
  forged.searchParams.set("sig", "0".repeat(64));
  const bad = await serveEngineMedia({ request: new Request(forged), getSql: async () => db.sql, objectStore: () => store, secret: SECRET, nowSeconds: () => NOW + 60 });
  assert.equal(bad.status, 403);
  assert.deepEqual(store.lookups, [], "no object is read for a link that does not verify");
});

test("a link signed for another organization finds no request, so nothing is served", async () => {
  // The key names org A's request. The link is signed for org B, so the request lookup is in org B and finds nothing.
  const store = storeWith({ [`${ORG_B}/brand_b/${KEY_A}`]: { bytes: BYTES, mimeType: "video/mp4" } });
  const sameKeyForB = `engine/${ORG_B}/${REQ_A}/render/vid_01.mp4`;
  const url = await link({ organizationId: ORG_B, key: sameKeyForB });
  const response = await serveEngineMedia({ request: new Request(url), getSql: async () => db.sql, objectStore: () => store, secret: SECRET, nowSeconds: () => NOW + 60 });
  assert.equal(response.status, 404);
  assert.deepEqual(store.lookups, [], "the request does not belong to organization B, so the object is never read");
});

test("the route answers as if nothing exists when the secret is unset, and refuses a MIME type that does not match the key", async () => {
  const store = storeWith({ [`${ORG_A}/brand_a/${KEY_A}`]: { bytes: BYTES, mimeType: "image/png" } });
  const url = await link({ organizationId: ORG_A, key: KEY_A });
  const unset = await serveEngineMedia({ request: new Request(url), getSql: async () => db.sql, objectStore: () => store, secret: null, nowSeconds: () => NOW + 60 });
  assert.equal(unset.status, 404);
  const mismatch = await serveEngineMedia({ request: new Request(url), getSql: async () => db.sql, objectStore: () => store, secret: SECRET, nowSeconds: () => NOW + 60 });
  assert.equal(mismatch.status, 404, "a stored PNG under an mp4 key is not served");
});

test("isKitMediaKey accepts a kit image of its own organization only, and only the kit rule (png, a kind with images, a kit id)", () => {
  assert.equal(isKitMediaKey(ORG_A, KIT_A), true);
  assert.equal(isKitMediaKey(ORG_B, KIT_A), false, "another organization's kit image is refused");
  assert.equal(isKitMediaKey(ORG_A, `kits/${ORG_A}/brand_a/persona/per_1/portrait-1.png`), true, "a persona's portrait is a kit image");
  assert.equal(isKitMediaKey(ORG_A, `kits/${ORG_A}/brand_a/product/prod_1/front.png`), true, "a product's image is a kit image");
  assert.equal(isKitMediaKey(ORG_A, `kits/${ORG_A}/brand_a/voice/voice_1/clip.png`), false, "a voice kit carries no image");
  assert.equal(isKitMediaKey(ORG_A, `kits/${ORG_A}/brand_a/character/char_1/sheet-1.jpg`), false, "only png is a kit image in this rule");
  assert.equal(isKitMediaKey(ORG_A, `kits/${ORG_A}/brand_a/character/char_1/sub/sheet-1.png`), false, "an extra path part is refused");
  assert.equal(isKitMediaKey(ORG_A, `kits/${ORG_A}/brand_a/character/../sheet-1.png`), false, "a dot-dot path is refused");
  assert.equal(isKitMediaKey(ORG_A, `kits/${ORG_A}//character/char_1/sheet-1.png`), false, "an empty brand is refused");
  assert.equal(isKitMediaKey(ORG_A, `store/${ORG_A}/brand_a/character/char_1/sheet-1.png`), false, "an unknown prefix is refused");
  assert.equal(isLinkableMediaKey(ORG_A, KEY_A), true, "an engine media object is still linkable");
  assert.equal(isLinkableMediaKey(ORG_B, KIT_A), false, "linkable is org-scoped for kits too");
  assert.deepEqual(kitKeyParts(KIT_A), { organizationId: ORG_A, brandId: "brand_a", kind: "character", kitId: "char_1", name: "sheet-1" });
  assert.equal(kitKeyParts(KEY_A), null);
});

test("the signer links a kit image of its own organization for 15 minutes, and refuses another organization's kit image (nothing signed)", async () => {
  const signer = engineMediaLinkSigner({ secret: () => SECRET, origin: () => ORIGIN, nowSeconds: () => NOW });
  const own = await signer.sign(ORG_A, KIT_A, MEDIA_LINK_TTL_SECONDS);
  assert.equal(own.status, "ok");
  if (own.status !== "ok") throw new Error("expected a signed link");
  const url = new URL(own.url);
  assert.equal(url.searchParams.get("org"), ORG_A);
  assert.equal(url.searchParams.get("key"), KIT_A);
  assert.equal(Number(url.searchParams.get("expires")), NOW + 15 * 60);
  const other = await signer.sign(ORG_A, KIT_B, MEDIA_LINK_TTL_SECONDS);
  assert.equal(other.status, "refused", "a kit image of organization B is refused for organization A");
  assert.equal("url" in other, false, "no URL is returned for a refused kit image");
});

test("the signer fails closed for a kit image without the secret or the public origin, and names the setting", async () => {
  const noSecret = engineMediaLinkSigner({ secret: () => null, origin: () => ORIGIN, nowSeconds: () => NOW });
  const noSecretResult = await noSecret.sign(ORG_A, KIT_A, MEDIA_LINK_TTL_SECONDS);
  assert.equal(noSecretResult.status, "not_connected");
  assert.match(noSecretResult.status === "not_connected" ? noSecretResult.reason : "", /MEDIA_LINK_SECRET/);
  const noOrigin = engineMediaLinkSigner({ secret: () => SECRET, origin: () => null, nowSeconds: () => NOW });
  const noOriginResult = await noOrigin.sign(ORG_A, KIT_A, MEDIA_LINK_TTL_SECONDS);
  assert.equal(noOriginResult.status, "not_connected");
  assert.match(noOriginResult.status === "not_connected" ? noOriginResult.reason : "", /APP_URL or PUBLIC_APP_URL/);
  assert.doesNotMatch(noOriginResult.status === "not_connected" ? noOriginResult.reason : "", /Shotstack/, "the reason is not specific to one provider");
});

test("a valid link for the organization's kit image resolves to its bytes, read under the brand its key names", async () => {
  const store = storeWith({ [`${ORG_A}/brand_a/${KIT_A}`]: { bytes: PNG_BYTES, mimeType: "image/png" } });
  const url = await link({ organizationId: ORG_A, key: KIT_A });
  const response = await serveEngineMedia({
    request: new Request(url),
    getSql: async () => db.sql,
    objectStore: () => store,
    secret: SECRET,
    nowSeconds: () => NOW + 60,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), PNG_BYTES);
  assert.deepEqual(store.lookups, [`${ORG_A}/brand_a/${KIT_A}`]);
});

test("an expired kit image link is refused, and no kit image is read for it", async () => {
  const store = storeWith({ [`${ORG_A}/brand_a/${KIT_A}`]: { bytes: PNG_BYTES, mimeType: "image/png" } });
  const url = await link({ organizationId: ORG_A, key: KIT_A });
  const expired = await serveEngineMedia({
    request: new Request(url),
    getSql: async () => db.sql,
    objectStore: () => store,
    secret: SECRET,
    nowSeconds: () => NOW + 15 * 60,
  });
  assert.equal(expired.status, 403);
  assert.deepEqual(store.lookups, [], "an expired link reads nothing");
});

test("a link re-pointed at another organization's kit image is refused, and nothing is read", async () => {
  const store = storeWith({
    [`${ORG_A}/brand_a/${KIT_A}`]: { bytes: PNG_BYTES, mimeType: "image/png" },
    [`${ORG_B}/brand_b/${KIT_B}`]: { bytes: PNG_BYTES, mimeType: "image/png" },
  });
  const ownLink = new URL(await link({ organizationId: ORG_A, key: KIT_A }));
  ownLink.searchParams.set("key", KIT_B);
  const swapped = await serveEngineMedia({ request: new Request(ownLink), getSql: async () => db.sql, objectStore: () => store, secret: SECRET, nowSeconds: () => NOW + 60 });
  assert.equal(swapped.status, 403, "the signature covers the key, so a swapped key does not verify");
  const otherLink = new URL(await link({ organizationId: ORG_B, key: KIT_B }));
  otherLink.searchParams.set("org", ORG_A);
  const swappedOrg = await serveEngineMedia({ request: new Request(otherLink), getSql: async () => db.sql, objectStore: () => store, secret: SECRET, nowSeconds: () => NOW + 60 });
  assert.equal(swappedOrg.status, 403, "the signature covers the organization, so another organization's link does not verify here");
  assert.deepEqual(store.lookups, [], "no kit image is read for a link that does not verify");
});

test("a kit image is read only under the brand its key names, and a stored type that is not png is not served", async () => {
  const otherBrand = storeWith({ [`${ORG_A}/brand_c/${KIT_A}`]: { bytes: PNG_BYTES, mimeType: "image/png" } });
  const url = await link({ organizationId: ORG_A, key: KIT_A });
  const missing = await serveEngineMedia({ request: new Request(url), getSql: async () => db.sql, objectStore: () => otherBrand, secret: SECRET, nowSeconds: () => NOW + 60 });
  assert.equal(missing.status, 404, "the object under another brand is not the kit image this key names");
  const mismatched = storeWith({ [`${ORG_A}/brand_a/${KIT_A}`]: { bytes: BYTES, mimeType: "video/mp4" } });
  const wrongType = await serveEngineMedia({ request: new Request(url), getSql: async () => db.sql, objectStore: () => mismatched, secret: SECRET, nowSeconds: () => NOW + 60 });
  assert.equal(wrongType.status, 404, "a stored mp4 under a png kit key is not served");
});

test("the route answers as if nothing exists for a kit image when the secret is unset", async () => {
  const store = storeWith({ [`${ORG_A}/brand_a/${KIT_A}`]: { bytes: PNG_BYTES, mimeType: "image/png" } });
  const url = await link({ organizationId: ORG_A, key: KIT_A });
  const unset = await serveEngineMedia({ request: new Request(url), getSql: async () => db.sql, objectStore: () => store, secret: null, nowSeconds: () => NOW + 60 });
  assert.equal(unset.status, 404);
  assert.deepEqual(store.lookups, []);
});
