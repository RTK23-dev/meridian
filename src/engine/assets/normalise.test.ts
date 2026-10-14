import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeBase64Strict, normaliseHttpsUrl, normaliseImage, normaliseSpeech, OUTPUT_LIMITS, sniffImage } from "./normalise.ts";
import { mp3Bytes, pngBytes } from "./test/recorded.ts";

describe("image output", () => {
  it("accepts a PNG whose bytes match the declared type", () => {
    const checked = normaliseImage(pngBytes(), "image/png");
    assert.equal(checked.ok, true);
    if (checked.ok) assert.equal(checked.value.mediaType, "image/png");
  });

  it("accepts a declared type with parameters and detects JPEG and WEBP by their signatures", () => {
    const jpeg = new Uint8Array(2048);
    jpeg.set([0xff, 0xd8, 0xff, 0xe0], 0);
    assert.equal(normaliseImage(jpeg, "image/jpeg; charset=binary").ok, true);
    const webp = new Uint8Array(2048);
    webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], 0);
    assert.equal(sniffImage(webp), "image/webp");
  });

  it("refuses SVG and any other type, even when the bytes look like an image", () => {
    const checked = normaliseImage(pngBytes(), "image/svg+xml");
    assert.equal(checked.ok, false);
    if (!checked.ok) assert.match(checked.reason, /not accepted/);
  });

  it("refuses bytes that do not match the declared type", () => {
    const checked = normaliseImage(pngBytes(), "image/jpeg");
    assert.equal(checked.ok, false);
  });

  it("refuses an image below the size floor or above the ceiling", () => {
    assert.equal(normaliseImage(pngBytes(OUTPUT_LIMITS.imageMinBytes - 1), "image/png").ok, false);
  });
});

describe("speech output", () => {
  it("accepts MP3 with an ID3 tag or an MPEG frame sync, and refuses other bytes", () => {
    assert.equal(normaliseSpeech(mp3Bytes(), "audio/mpeg").ok, true);
    const framed = new Uint8Array(2048);
    framed.set([0xff, 0xfb, 0x90, 0x00], 0);
    assert.equal(normaliseSpeech(framed, "audio/mpeg").ok, true);
    const notMp3 = new Uint8Array(2048);
    notMp3.set([0x52, 0x49, 0x46, 0x46], 0);
    const checked = normaliseSpeech(notMp3, "audio/mpeg");
    assert.equal(checked.ok, false);
  });

  it("refuses a declared type other than audio/mpeg", () => {
    assert.equal(normaliseSpeech(mp3Bytes(), "audio/wav").ok, false);
  });
});

describe("provider URLs", () => {
  it("accepts an https URL and refuses http, user information, whitespace and an empty value", () => {
    assert.equal(normaliseHttpsUrl("https://videos.example.com/a.mp4").ok, true);
    assert.equal(normaliseHttpsUrl("http://videos.example.com/a.mp4").ok, false);
    assert.equal(normaliseHttpsUrl("https://user:secret@videos.example.com/a.mp4").ok, false);
    assert.equal(normaliseHttpsUrl("https://videos.example.com/a b.mp4").ok, false);
    assert.equal(normaliseHttpsUrl("").ok, false);
    assert.equal(normaliseHttpsUrl("not a url").ok, false);
  });
});

describe("base64 payloads", () => {
  it("decodes canonical base64 and refuses anything else", () => {
    const decoded = decodeBase64Strict("aGVsbG8=");
    assert.equal(decoded.ok, true);
    if (decoded.ok) assert.equal(Buffer.from(decoded.value).toString("utf8"), "hello");
    assert.equal(decodeBase64Strict("aGVsbG8").ok, false);
    assert.equal(decodeBase64Strict("aGVs bG8=").ok, false);
    assert.equal(decodeBase64Strict("").ok, false);
  });
});
