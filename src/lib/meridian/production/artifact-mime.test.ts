import assert from "node:assert/strict";
import test from "node:test";
import { detectArtifactType, UnknownArtifactFormatError } from "./mime-detector.ts";

test("detectArtifactType: recognizes valid binary formats", () => {
  // Valid PNG header (8 bytes)
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  const png = detectArtifactType(pngBytes);
  assert.equal(png.mimeType, "image/png");
  assert.equal(png.extension, "png");
  assert.equal(png.category, "image");

  // Valid JPEG header
  const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const jpeg = detectArtifactType(jpegBytes);
  assert.equal(jpeg.mimeType, "image/jpeg");
  assert.equal(jpeg.extension, "jpg");

  // Valid MP4 header (ftyp box)
  const mp4Bytes = new Uint8Array([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, // size 24, 'ftyp'
    0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00, // isom
  ]);
  const mp4 = detectArtifactType(mp4Bytes);
  assert.equal(mp4.mimeType, "video/mp4");
  assert.equal(mp4.extension, "mp4");
  assert.equal(mp4.category, "video");
});

test("detectArtifactType: fails closed on HTML error pages", () => {
  const htmlBytes = new TextEncoder().encode("<!DOCTYPE html><html><body><h1>502 Bad Gateway</h1></body></html>");
  assert.throws(
    () => detectArtifactType(htmlBytes),
    (err: any) => {
      assert.ok(err instanceof UnknownArtifactFormatError);
      assert.match(err.message, /HTML error document/);
      return true;
    }
  );
});

test("detectArtifactType: fails closed on JSON error responses", () => {
  const jsonBytes = new TextEncoder().encode('{"error":{"code":429,"message":"Resource exhausted"}}');
  assert.throws(
    () => detectArtifactType(jsonBytes),
    (err: any) => {
      assert.ok(err instanceof UnknownArtifactFormatError);
      assert.match(err.message, /JSON error response/);
      return true;
    }
  );
});

test("detectArtifactType: fails closed on truncated MP4 headers", () => {
  const truncated = new Uint8Array([0x00, 0x00, 0x00, 0x18]); // less than 8 bytes
  assert.throws(
    () => detectArtifactType(truncated),
    (err: any) => {
      assert.ok(err instanceof UnknownArtifactFormatError);
      assert.match(err.message, /too short/);
      return true;
    }
  );
});

test("detectArtifactType: fails closed on random bytes without guessing video/mp4", () => {
  const randomBytes = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]);
  assert.throws(
    () => detectArtifactType(randomBytes),
    (err: any) => {
      assert.ok(err instanceof UnknownArtifactFormatError);
      assert.match(err.message, /Unsupported or unrecognized artifact format/);
      return true;
    }
  );
});

test("detectArtifactType: every format returns its canonical extension and the category it is matched by", () => {
  const pad = (head: number[]) => new Uint8Array([...head, ...new Array(24).fill(0)]);
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  const cases: Array<{ name: string; bytes: Uint8Array; mimeType: string; extension: string; category: string }> = [
    { name: "png", bytes: pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), mimeType: "image/png", extension: "png", category: "image" },
    { name: "jpeg", bytes: pad([0xff, 0xd8, 0xff, 0xe0]), mimeType: "image/jpeg", extension: "jpg", category: "image" },
    { name: "webp", bytes: pad([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]), mimeType: "image/webp", extension: "webp", category: "image" },
    // An animated GIF is a motion clip for production, so it is matched as video.
    { name: "gif", bytes: pad([...ascii("GIF89a")]), mimeType: "image/gif", extension: "gif", category: "video" },
    { name: "mp4", bytes: pad([0, 0, 0, 0x18, ...ascii("ftypisom")]), mimeType: "video/mp4", extension: "mp4", category: "video" },
    { name: "webm", bytes: pad([0x1a, 0x45, 0xdf, 0xa3]), mimeType: "video/webm", extension: "webm", category: "video" },
    { name: "mov", bytes: pad([0, 0, 0, 0x14, ...ascii("moov")]), mimeType: "video/quicktime", extension: "mov", category: "video" },
    { name: "pdf", bytes: pad(ascii("%PDF-1.7")), mimeType: "application/pdf", extension: "pdf", category: "document" },
  ];
  for (const c of cases) {
    const detected = detectArtifactType(c.bytes);
    assert.deepEqual({ mimeType: detected.mimeType, extension: detected.extension, category: detected.category }, { mimeType: c.mimeType, extension: c.extension, category: c.category }, c.name);
  }
});
