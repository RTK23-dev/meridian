// Checks for Content Factory files. A binary type comes from its bytes and has its own size limit. A text file is checked as text, takes its
// type from its name (Markdown, CSV or JSON, and JSON must parse) and is read into the brief up to TEXT_FILE_MAX_CHARS characters. A
// reference must be a video, and an upload that is not whole base64 is refused before it is decoded.

import assert from "node:assert/strict";
import { test } from "node:test";
import { characterCount, checkFile, decodeUpload, imageDimensions, MAX_BASE64_CHARS, referenceVideoUri, safeFileName, sessionFileKey, sniffBinaryMediaType, TEXT_FILE_MAX_CHARS, textMediaTypeOf } from "./files.ts";

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]);
const MOV = new Uint8Array([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20, 0, 0, 0, 0]);
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const TEXT = encode("Hook: show the blender first.\nThen the price.");
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
const PDF = encode("%PDF-1.7\n\u0001\u0002");

test("a binary type is read from its bytes, and text is not a binary type", () => {
  assert.equal(sniffBinaryMediaType(MP4), "video/mp4");
  assert.equal(sniffBinaryMediaType(MOV), "video/quicktime");
  assert.equal(sniffBinaryMediaType(WEBM), "video/webm");
  assert.equal(sniffBinaryMediaType(PNG), "image/png");
  assert.equal(sniffBinaryMediaType(JPEG), "image/jpeg");
  assert.equal(sniffBinaryMediaType(WEBP), "image/webp");
  assert.equal(sniffBinaryMediaType(PDF), "application/pdf");
  assert.equal(sniffBinaryMediaType(TEXT), null);
  assert.equal(sniffBinaryMediaType(EXE), null, "a Windows program is not a binary type the session takes");
});

test("an image header gives width and height, and a header that does not is not a size", () => {
  const png = new Uint8Array(24);
  png.set(PNG);
  png.set([0x49, 0x48, 0x44, 0x52], 12);
  png[16] = 0;
  png[17] = 0;
  png[18] = 0x02;
  png[19] = 0x80;
  png[22] = 0x01;
  png[23] = 0x40;
  assert.deepEqual(imageDimensions(png), { width: 640, height: 320 });
  assert.equal(imageDimensions(PNG), null, "a PNG signature without an IHDR size is not a size");
  assert.equal(imageDimensions(TEXT), null);
});

test("a text file takes its type from its name, and the bytes still decide what is text", () => {
  assert.equal(textMediaTypeOf("notes.txt"), "text/plain");
  assert.equal(textMediaTypeOf("Angle.MD"), "text/markdown");
  assert.equal(textMediaTypeOf("launch.markdown"), "text/markdown");
  assert.equal(textMediaTypeOf("prices.csv"), "text/csv");
  assert.equal(textMediaTypeOf("facts.json"), "application/json");
  assert.equal(textMediaTypeOf("README"), "text/plain");
  assert.equal(textMediaTypeOf("folder.v2/notes"), "text/plain", "a dot in a folder name is not an extension");
  const pngNamedText = checkFile(PNG, "material", "notes.txt");
  assert.ok(pngNamedText.ok && pngNamedText.file.mediaType === "image/png", "the bytes decide: a PNG named .txt is still a PNG");
});

test("a small text file is checked as text and comes back with its content for the brief", () => {
  const checked = checkFile(TEXT, "material", "hook.txt");
  assert.ok(checked.ok);
  assert.equal(checked.file.kind, "text");
  assert.equal(checked.file.mediaType, "text/plain");
  assert.equal(checked.file.extension, "txt");
  assert.equal(checked.file.content, "Hook: show the blender first.\nThen the price.");
  assert.equal(checked.file.bytes, TEXT.byteLength);
  assert.match(checked.file.sha256, /^[0-9a-f]{64}$/);

  const markdown = checkFile(encode("# Angle\n- quiet"), "material", "angle.md");
  assert.ok(markdown.ok);
  assert.equal(markdown.file.mediaType, "text/markdown");

  const csv = checkFile(encode("name,price\nX,89"), "material", "prices.csv");
  assert.ok(csv.ok);
  assert.equal(csv.file.mediaType, "text/csv");

  const json = checkFile(encode('{"claim":"quiet"}'), "material", "facts.json");
  assert.ok(json.ok);
  assert.equal(json.file.mediaType, "application/json");
  assert.equal(json.file.content, '{"claim":"quiet"}');
});

test("a text file over the character limit is refused with the limit, and one at the limit is kept", () => {
  const over = checkFile(encode("a".repeat(TEXT_FILE_MAX_CHARS + 1)), "material", "long.txt");
  assert.equal(over.ok, false);
  assert.equal(
    over.ok ? "" : over.reason,
    "This file has 4001 characters; the limit for a text file is 4000. Shorten it or split it into two files.",
  );
  assert.ok(checkFile(encode("a".repeat(TEXT_FILE_MAX_CHARS)), "material", "limit.txt").ok, "exactly the limit is kept");

  // The limit is in characters, not bytes: an accented letter is two bytes, and a long file is refused by its characters, not its size.
  const accents = checkFile(encode("é".repeat(TEXT_FILE_MAX_CHARS + 1)), "material", "accents.txt");
  assert.match(accents.ok ? "" : accents.reason, /has 4001 characters/);
  const large = checkFile(encode("a".repeat(1_500_000)), "material", "large.txt");
  assert.match(large.ok ? "" : large.reason, /has 1500000 characters; the limit for a text file is 4000/);

  // An emoji is one character, as the engine's schema counts it, though it is two UTF-16 units.
  assert.ok(checkFile(encode("😀".repeat(TEXT_FILE_MAX_CHARS)), "material", "emoji.txt").ok);
  assert.equal(characterCount("😀😀😀"), 3);
  assert.equal(characterCount("a😀é"), 3);
});

test("invalid UTF-8, NUL bytes, control characters, a blank text file and bad JSON are refused in plain words", () => {
  const invalid = checkFile(new Uint8Array([0x61, 0xc3, 0x28]), "material", "bad.txt");
  assert.equal(invalid.ok, false);
  assert.match(invalid.ok ? "" : invalid.reason, /not valid UTF-8 text/);

  const nul = checkFile(new Uint8Array([0x61, 0x00, 0x62]), "material", "nul.txt");
  assert.equal(nul.ok, false);
  assert.match(nul.ok ? "" : nul.reason, /has NUL bytes, so it is not plain text/);

  const program = checkFile(EXE, "material", "setup.mp4");
  assert.match(program.ok ? "" : program.reason, /NUL bytes.*not accepted/, "a program named .mp4 is still refused");

  const control = checkFile(encode("note\u0001\u0002"), "material", "control.txt");
  assert.match(control.ok ? "" : control.reason, /control characters/);

  const blank = checkFile(encode(" \n\t "), "material", "blank.txt");
  assert.match(blank.ok ? "" : blank.reason, /no text in it/);

  const badJson = checkFile(encode("{not json"), "material", "facts.json");
  assert.match(badJson.ok ? "" : badJson.reason, /not valid JSON/);
});

test("a file is checked for its purpose and its type's size limit", () => {
  const video = checkFile(MP4, "reference_video");
  assert.ok(video.ok);
  assert.equal(video.file.mediaType, "video/mp4");
  assert.equal(video.file.content, null);
  assert.match(video.file.sha256, /^[0-9a-f]{64}$/);

  const image = checkFile(PNG, "reference_video");
  assert.equal(image.ok, false);
  assert.match(image.ok ? "" : image.reason, /reference must be a video/);
  assert.ok(checkFile(PNG, "material").ok, "an image is accepted as material");

  const textReference = checkFile(TEXT, "reference_video", "notes.txt");
  assert.match(textReference.ok ? "" : textReference.reason, /reference must be a video/, "text is never the reference");

  const pdf = checkFile(PDF, "material", "specs.pdf");
  assert.ok(pdf.ok);
  assert.equal(pdf.file.mediaType, "application/pdf");
  assert.equal(pdf.file.content, null, "a PDF's text is not read");
  assert.equal(checkFile(PDF, "reference_video", "specs.pdf").ok, false, "a PDF is never the reference");

  const bigPdf = new Uint8Array(10_000_001);
  bigPdf.set(PDF);
  const tooBigPdf = checkFile(bigPdf, "material", "big.pdf");
  assert.match(tooBigPdf.ok ? "" : tooBigPdf.reason, /This PDF can be at most 10 MB/);

  const empty = checkFile(new Uint8Array(), "material");
  assert.equal(empty.ok, false);
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
