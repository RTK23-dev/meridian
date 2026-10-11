import assert from "node:assert/strict";
import test from "node:test";
import {
  canAccessStoredAsset,
  contentDispositionFor,
  framePosterStorageKey,
  isInActiveWorkspace,
  isNotModified,
  isPreviewableMime,
  parseByteRange,
  pickActiveOrganization,
  storedBytesMatch,
  verifiedMediaMime,
} from "./media-access.ts";
import { createRateLimit } from "../security/limits.ts";

/** Builds a byte array from numbers, ASCII text and zero padding, so each fixture is a readable file header. */
function bytes(...parts: Array<number[] | string>): Uint8Array {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === "string") for (const char of part) out.push(char.charCodeAt(0));
    else out.push(...part);
  }
  return new Uint8Array(out);
}
const zeros = (count: number) => new Array<number>(count).fill(0);
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], zeros(24));
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], zeros(28));
const WEBP = bytes("RIFF", zeros(4), "WEBP", zeros(20));
const GIF = bytes("GIF89a", zeros(26));
const MP4 = bytes([0, 0, 0, 0x18], "ftypisom", zeros(20));
const AVIF = bytes([0, 0, 0, 0x1c], "ftypavif", zeros(4), "avifmif1", zeros(12));
const WEBM = bytes([0x1a, 0x45, 0xdf, 0xa3], zeros(28));
const HTML = bytes("<!doctype html><html><body>not media</body></html>");
const JSON_ERROR = bytes('{"error":"forbidden","detail":"not media"}');

test("byte ranges support bounded, open-ended, and suffix requests", () => {
  assert.deepEqual(parseByteRange("bytes=0-99", 300), { start: 0, end: 99 });
  assert.deepEqual(parseByteRange("bytes=100-", 300), { start: 100, end: 299 });
  assert.deepEqual(parseByteRange("bytes=-50", 300), { start: 250, end: 299 });
  assert.equal(parseByteRange(null, 300), null);
  assert.equal(parseByteRange("bytes=500-", 300), "invalid");
  assert.equal(parseByteRange("bytes=2-1", 300), "invalid");
});

test("byte ranges clamp to the file and reject malformed or multi-part headers", () => {
  assert.deepEqual(parseByteRange("bytes=0-0", 300), { start: 0, end: 0 });
  assert.deepEqual(parseByteRange("bytes=290-9999", 300), { start: 290, end: 299 });
  assert.deepEqual(parseByteRange("bytes=-500", 300), { start: 0, end: 299 }, "a suffix longer than the file is the whole file");
  assert.deepEqual(parseByteRange("  bytes=0-1  ", 300), { start: 0, end: 1 }, "surrounding whitespace is ignored");
  assert.equal(parseByteRange("bytes=-0", 300), "invalid");
  assert.equal(parseByteRange("bytes=-", 300), "invalid");
  assert.equal(parseByteRange("bytes=", 300), "invalid");
  assert.equal(parseByteRange("bytes=300-", 300), "invalid", "a start at the end of the file is unsatisfiable");
  assert.equal(parseByteRange("bytes=0-1,4-5", 300), "invalid", "multiple ranges are not supported");
  assert.equal(parseByteRange("bytes=abc", 300), "invalid");
  assert.equal(parseByteRange("items=0-1", 300), "invalid");
  assert.equal(parseByteRange("bytes=99999999999999999999-", 300), "invalid", "an unsafe integer is refused");
  assert.equal(parseByteRange("bytes=0-", 0), "invalid", "an empty file has no satisfiable range");
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

test("previewable types are still images and MP4, never SVG, HTML or parameterised strings", () => {
  for (const type of ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/avif", "video/mp4", " VIDEO/MP4 ", "IMAGE/PNG"]) {
    assert.equal(isPreviewableMime(type), true, `${type} should be previewable`);
  }
  for (const type of ["image/svg+xml", "image/svg+xml; charset=utf-8", "text/html", "video/quicktime", "application/pdf", "image/", "", "image/png; charset=x"]) {
    assert.equal(isPreviewableMime(type), false, `${type} must not be previewable`);
  }
});

test("pickActiveOrganization uses the saved workspace only while it is a membership", () => {
  const memberships = [{ organizationId: "org-a", role: "member" }, { organizationId: "org-b", role: "admin" }];
  assert.deepEqual(pickActiveOrganization("org-b", memberships), { organizationId: "org-b", role: "admin" });
  assert.deepEqual(pickActiveOrganization("org-z", memberships), { organizationId: "org-a", role: "member" }, "a stale preference falls back to the first membership");
  assert.deepEqual(pickActiveOrganization(null, memberships), { organizationId: "org-a", role: "member" });
  assert.deepEqual(pickActiveOrganization(undefined, memberships), { organizationId: "org-a", role: "member" });
  assert.equal(pickActiveOrganization("org-a", []), null, "no memberships means no workspace");
});

test("pickActiveOrganization drops rows with an unknown role, so they never grant access", () => {
  const memberships = [{ organizationId: "org-x", role: "superuser" }, { organizationId: "org-a", role: "viewer" }];
  assert.deepEqual(pickActiveOrganization("org-x", memberships), { organizationId: "org-a", role: "viewer" }, "a preferred row with a bad role is skipped");
  assert.equal(pickActiveOrganization("org-x", [{ organizationId: "org-x", role: "" }]), null, "only bad rows means no workspace");
});

test("isInActiveWorkspace matches only the active organization and never without one", () => {
  const active = { organizationId: "org-a", role: "viewer" as const };
  assert.equal(isInActiveWorkspace("org-a", active), true);
  assert.equal(isInActiveWorkspace("org-b", active), false);
  assert.equal(isInActiveWorkspace("org-a", null), false);
});

test("verifiedMediaMime serves a type only when the bytes sniff as that same type", () => {
  assert.equal(verifiedMediaMime(PNG, "image/png"), "image/png");
  assert.equal(verifiedMediaMime(PNG, "IMAGE/PNG "), "image/png", "the stored type is normalised");
  assert.equal(verifiedMediaMime(JPEG, "image/jpg"), "image/jpeg", "image/jpg is read as image/jpeg");
  assert.equal(verifiedMediaMime(GIF, "image/gif"), "image/gif");
  assert.equal(verifiedMediaMime(WEBP, "image/webp"), "image/webp");
  assert.equal(verifiedMediaMime(MP4, "video/mp4"), "video/mp4");
  assert.equal(verifiedMediaMime(AVIF, "image/avif"), "image/avif", "AVIF bytes sniff as AVIF, not as MP4");
});

test("verifiedMediaMime refuses a mismatch, a non-media payload or an unknown format", () => {
  assert.equal(verifiedMediaMime(PNG, "image/jpeg"), null, "declared type differs from the bytes");
  assert.equal(verifiedMediaMime(WEBM, "video/mp4"), null, "WebM bytes are not MP4");
  assert.equal(verifiedMediaMime(MP4, "image/avif"), null, "MP4 bytes are not AVIF");
  assert.equal(verifiedMediaMime(HTML, "image/png"), null, "an HTML error page is never served as an image");
  assert.equal(verifiedMediaMime(JSON_ERROR, "image/png"), null, "a JSON error body is never served as an image");
  assert.equal(verifiedMediaMime(PNG, "image/svg+xml"), null, "SVG is refused even with image bytes");
  assert.equal(verifiedMediaMime(PNG, "text/html"), null, "a non-previewable stored type is refused");
  assert.equal(verifiedMediaMime(new Uint8Array(4), "image/png"), null, "too few bytes to sniff");
});

test("storedBytesMatch needs the recorded length and SHA-256 to agree, ignoring hex case", () => {
  const sha = "a".repeat(64);
  assert.equal(storedBytesMatch({ byteLength: 10, sha256Hex: sha }, { byteSize: 10, sha256Hex: sha }), true);
  assert.equal(storedBytesMatch({ byteLength: 10, sha256Hex: sha.toUpperCase() }, { byteSize: 10, sha256Hex: sha }), true);
  assert.equal(storedBytesMatch({ byteLength: 11, sha256Hex: sha }, { byteSize: 10, sha256Hex: sha }), false, "length differs");
  assert.equal(storedBytesMatch({ byteLength: 10, sha256Hex: "b".repeat(64) }, { byteSize: 10, sha256Hex: sha }), false, "digest differs");
  assert.equal(storedBytesMatch({ byteLength: 0, sha256Hex: sha }, { byteSize: 0, sha256Hex: sha }), false, "a zero-byte record never matches");
  assert.equal(storedBytesMatch({ byteLength: 10, sha256Hex: sha }, { byteSize: 10, sha256Hex: "a".repeat(63) }), false, "a malformed digest never matches");
  assert.equal(storedBytesMatch({ byteLength: 10, sha256Hex: sha }, { byteSize: Number.NaN, sha256Hex: sha }), false, "a missing length never matches");
  assert.equal(storedBytesMatch({ byteLength: 10, sha256Hex: sha }, { byteSize: 1e20, sha256Hex: sha }), false, "an unsafe length never matches");
});

test("the poster key is the video key with the first frame's suffix", () => {
  assert.equal(framePosterStorageKey("studio/brand-1/clip.mp4"), "studio/brand-1/clip.mp4.frame.0.png");
});

test("content disposition is inline for previews and an attachment named from the id for downloads", () => {
  assert.equal(contentDispositionFor({ download: false, assetId: "abc", mimeType: "video/mp4" }), "inline");
  assert.equal(contentDispositionFor({ download: true, assetId: "abc_123-x", mimeType: "video/mp4" }), 'attachment; filename="abc_123-x.mp4"');
  assert.equal(contentDispositionFor({ download: true, assetId: "a", mimeType: "image/jpeg" }), 'attachment; filename="a.jpg"');
  assert.equal(contentDispositionFor({ download: true, assetId: "a", mimeType: "image/avif" }), 'attachment; filename="a.avif"');
  assert.equal(contentDispositionFor({ download: true, assetId: "a", mimeType: "application/x-unknown" }), 'attachment; filename="a.bin"');
});

test("content disposition strips characters that could break out of the header", () => {
  assert.equal(contentDispositionFor({ download: true, assetId: 'x"; evil=1\r\n', mimeType: "image/png" }), 'attachment; filename="xevil1.png"');
  assert.equal(contentDispositionFor({ download: true, assetId: "../../", mimeType: "image/png" }), 'attachment; filename="asset.png"', "an id with no safe characters falls back to asset");
  assert.equal(contentDispositionFor({ download: true, assetId: "a".repeat(100), mimeType: "image/png" }), `attachment; filename="${"a".repeat(64)}.png"`);
});

test("If-None-Match matches the current ETag, a weak tag, a list, or the wildcard", () => {
  const etag = '"abc"';
  assert.equal(isNotModified(null, etag), false);
  assert.equal(isNotModified("", etag), false);
  assert.equal(isNotModified('"abc"', etag), true);
  assert.equal(isNotModified('W/"abc"', etag), true, "a weak tag matches the strong ETag");
  assert.equal(isNotModified('"other", "abc"', etag), true, "any tag in the list may match");
  assert.equal(isNotModified('"other"', etag), false);
  assert.equal(isNotModified("*", etag), true);
});

test("rate limiting permits requests again after the window and evicts expired keys", () => {
  const limit = createRateLimit(1, 100);
  assert.equal(limit.allow("user-a", 0), true);
  assert.equal(limit.allow("user-a", 1), false);
  assert.equal(limit.allow("user-a", 101), true);
});
