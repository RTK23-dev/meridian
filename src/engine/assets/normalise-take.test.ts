import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FFMPEG_LIMITS } from "../../../functions/ffmpeg/limits.ts";
import { normaliseUri, normaliseVideo, OUTPUT_LIMITS } from "./normalise.ts";

function mp4(size = 8192): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32], 0);
  return bytes;
}

describe("a finished take", () => {
  it("accepts an mp4 (ftyp at byte 4) between the size limits", () => {
    const checked = normaliseVideo(mp4());
    assert.equal(checked.ok, true);
    if (checked.ok) assert.equal(checked.value.mediaType, "video/mp4");
  });

  it("refuses bytes with no ftyp box, whatever their size", () => {
    const checked = normaliseVideo(new Uint8Array(8192).fill(0x41));
    assert.equal(checked.ok, false);
    if (!checked.ok) assert.match(checked.reason, /not an mp4/);
  });

  it("refuses a file below the floor and one above the ceiling", () => {
    assert.equal(normaliseVideo(mp4(OUTPUT_LIMITS.videoMinBytes - 1)).ok, false);
    const tooLarge = normaliseVideo(new Uint8Array(OUTPUT_LIMITS.videoMaxBytes + 1));
    assert.equal(tooLarge.ok, false);
    if (!tooLarge.ok) assert.match(tooLarge.reason, /outside/);
  });

  it("uses the media functions' input limit as its ceiling, so a take the functions cannot read is never stored", () => {
    assert.equal(OUTPUT_LIMITS.videoMaxBytes, FFMPEG_LIMITS.maxInputBytes);
  });
});

describe("a uri a provider adapter returned", () => {
  it("accepts a provider URL and a stored media uri", () => {
    assert.equal(normaliseUri("https://openrouter.ai/api/v1/videos/job-1/content?index=0").ok, true);
    assert.equal(normaliseUri("memory://org_1/abc").ok, true);
  });

  it("refuses an empty uri, one with whitespace or control characters, and one over the length limit", () => {
    assert.equal(normaliseUri("").ok, false);
    assert.equal(normaliseUri("https://example.com/a b").ok, false);
    assert.equal(normaliseUri("https://example.com/\u0007").ok, false);
    assert.equal(normaliseUri(`https://example.com/${"a".repeat(OUTPUT_LIMITS.urlMaxLength)}`).ok, false);
  });
});
