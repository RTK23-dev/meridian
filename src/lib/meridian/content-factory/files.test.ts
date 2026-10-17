// Attachment validation for Content Factory files: the type comes from the bytes, each type has its own size limit, a reference must be a
// video, and an upload that is not whole base64 is refused before it is decoded.

import assert from "node:assert/strict";
import { test } from "node:test";
import { checkFile, decodeUpload, MAX_BASE64_CHARS, referenceVideoUri, safeFileName, sessionFileKey, sniffMediaType } from "./files.ts";

const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]);
const MOV = new Uint8Array([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20, 0, 0, 0, 0]);
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const TEXT = new TextEncoder().encode("Hook: show the blender first.\nThen the price.");
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
const PDF = new TextEncoder().encode("%PDF-1.7\n\u0001\u0002");

test("the media type is read from the bytes", () => {
  assert.equal(sniffMediaType(MP4), "video/mp4");
  assert.equal(sniffMediaType(MOV), "video/quicktime");
  assert.equal(sniffMediaType(WEBM), "video/webm");
  assert.equal(sniffMediaType(PNG), "image/png");
  assert.equal(sniffMediaType(JPEG), "image/jpeg");
  assert.equal(sniffMediaType(WEBP), "image/webp");
  assert.equal(sniffMediaType(TEXT), "text/plain");
  assert.equal(sniffMediaType(EXE), null, "a Windows program is not accepted");
  assert.equal(sniffMediaType(PDF), "application/pdf");
  assert.equal(sniffMediaType(new TextEncoder().encode("note\u0001\u0002")), null, "text with control characters is not plain text");
  assert.equal(checkFile(PDF, "reference_video").ok, false, "a PDF is never the reference");
  assert.ok(checkFile(PDF, "material").ok);
  assert.equal(sniffMediaType(new Uint8Array([0xc3, 0x28])), null, "invalid UTF-8 is not plain text");
});

test("a file is checked for its purpose and its type's size limit", () => {
  const video = checkFile(MP4, "reference_video");
  assert.ok(video.ok);
  assert.equal(video.file.mediaType, "video/mp4");
  assert.match(video.file.sha256, /^[0-9a-f]{64}$/);

  const image = checkFile(PNG, "reference_video");
  assert.equal(image.ok, false);
  assert.match(image.ok ? "" : image.reason, /reference must be a video/);
  assert.ok(checkFile(PNG, "material").ok, "an image is accepted as material");

  const program = checkFile(EXE, "material");
  assert.equal(program.ok, false);
  assert.match(program.ok ? "" : program.reason, /not accepted/);

  const empty = checkFile(new Uint8Array(), "material");
  assert.equal(empty.ok, false);

  const bigText = new Uint8Array(1_000_001).fill(0x61);
  const tooBig = checkFile(bigText, "material");
  assert.equal(tooBig.ok, false, "plain text over 1 MB is refused");
  assert.match(tooBig.ok ? "" : tooBig.reason, /text file can be at most 1 MB/);
});

test("an upload must be whole base64 within the size limit", () => {
  assert.equal(decodeUpload("").ok, false);
  assert.equal(decodeUpload("not base64!").ok, false);
  assert.equal(decodeUpload("abc").ok, false, "a length that is not a multiple of 4 did not arrive whole");
  assert.equal(decodeUpload("A".repeat(MAX_BASE64_CHARS + 4)).ok, false);
  const decoded = decodeUpload(Buffer.from(MP4).toString("base64"));
  assert.ok(decoded.ok);
  assert.deepEqual([...decoded.bytes], [...MP4]);
});

test("file names lose their path and control characters, and keys are named by content", () => {
  assert.equal(safeFileName("C:\\Users\\me\\Downloads\\reel.mp4"), "reel.mp4");
  assert.equal(safeFileName("../../etc/passwd"), "passwd");
  assert.equal(safeFileName("bad\u0000name\u0007.txt"), "badname.txt");
  assert.equal(safeFileName(42), "file");
  const key = sessionFileKey("sess-1", { sha256: "a".repeat(64), extension: "mp4" });
  assert.equal(key, `content-factory/sess-1/${"a".repeat(64)}.mp4`);
  assert.equal(referenceVideoUri(key), `store://${key}`);
});
