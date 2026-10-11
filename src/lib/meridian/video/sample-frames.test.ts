import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_SAMPLE_COUNT, isPng, sampleTimestamps, sampleVideoFrames, type FrameExtractor } from "./sample-frames.ts";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const ffmpegAvailable = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-version"]).status === 0;

test("sampled timestamps run from the opening frame toward the end, and stay inside the media", () => {
  const times = sampleTimestamps(10_000, DEFAULT_SAMPLE_COUNT);
  assert.equal(times.length, DEFAULT_SAMPLE_COUNT);
  assert.equal(times[0], 0, "the opening frame is sampled");
  assert.ok(times[times.length - 1]! < 10_000, "the last sample is inside the media");
  assert.deepEqual(times, [...times].sort((a, b) => a - b), "in order");
  assert.deepEqual(sampleTimestamps(10_000, 1), [0]);
  assert.equal(new Set(sampleTimestamps(3, 8)).size, sampleTimestamps(3, 8).length, "no duplicate times on a very short clip");
});

test("PNG detection reads the signature, not the file name", () => {
  assert.equal(isPng(PNG_BYTES), true);
  assert.equal(isPng(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), false, "a JPEG is not a PNG");
  assert.equal(isPng(new Uint8Array(0)), false);
});

test("each frame is recorded with the timestamp it was extracted at, and no other", async () => {
  const requested: number[] = [];
  const extractor: FrameExtractor = async (_path, timestampMs) => {
    requested.push(timestampMs);
    return PNG_BYTES;
  };
  const result = await sampleVideoFrames({ bytes: new Uint8Array([1, 2, 3]), durationMs: 8_000, count: 4, extractor });
  assert.deepEqual(result.frames.map((frame) => frame.timestampMs), requested, "recorded times are the times asked for");
  assert.deepEqual(result.frames.map((frame) => frame.timestampMs), sampleTimestamps(8_000, 4));
  assert.deepEqual(result.failures, []);
  assert.equal(result.unavailable, undefined);
});

test("a frame that cannot be extracted, or is not an image, is a recorded failure and never replaced", async () => {
  const extractor: FrameExtractor = async (_path, timestampMs) => {
    if (timestampMs === 0) throw new Error("decode error");
    if (timestampMs === sampleTimestamps(8_000, 4)[1]) return new Uint8Array([0xff, 0xd8]);
    return PNG_BYTES;
  };
  const result = await sampleVideoFrames({ bytes: new Uint8Array([1]), durationMs: 8_000, count: 4, extractor });
  assert.deepEqual(result.failures, [
    { timestampMs: 0, reason: "extract_failed" },
    { timestampMs: sampleTimestamps(8_000, 4)[1], reason: "not_png" },
  ]);
  assert.equal(result.frames.length, 2, "the two good frames are kept; nothing is invented to fill the gaps");
  assert.ok(!result.frames.some((frame) => frame.timestampMs === 0));
});

test("an unknown duration means nothing is sampled, and the reason says so", async () => {
  let called = false;
  const result = await sampleVideoFrames({
    bytes: new Uint8Array([1]),
    durationMs: null,
    extractor: async () => {
      called = true;
      return PNG_BYTES;
    },
  });
  assert.equal(result.unavailable, "no_duration");
  assert.equal(called, false, "no seek is attempted without a known duration");
});

test("a missing ffmpeg binary is reported as unavailable, not as a set of failed frames", async () => {
  const result = await sampleVideoFrames({
    bytes: new Uint8Array([1]),
    durationMs: 5_000,
    extractor: async () => {
      throw Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
    },
  });
  assert.equal(result.unavailable, "ffmpeg_unavailable");
  assert.deepEqual(result.frames, []);
  assert.deepEqual(result.failures, []);
});

test("the temporary container is removed after sampling", async () => {
  const seen: string[] = [];
  await sampleVideoFrames({
    bytes: new Uint8Array([9]),
    durationMs: 2_000,
    count: 2,
    extractor: async (path) => {
      seen.push(path);
      return PNG_BYTES;
    },
  });
  assert.ok(seen.length > 0);
  assert.throws(() => readFileSync(seen[0]!), "the container file no longer exists");
});

test("real ffmpeg: frames come out of an actual clip at the recorded timestamps", { skip: ffmpegAvailable ? false : "ffmpeg is not installed here" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "meridian-sample-test-"));
  try {
    const clip = join(dir, "clip.mp4");
    const made = spawnSync(process.env.FFMPEG_PATH || "ffmpeg", [
      "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=10",
      "-c:v", "mpeg4", "-pix_fmt", "yuv420p", "-movflags", "+faststart", clip,
    ]);
    assert.equal(made.status, 0, String(made.stderr));
    const result = await sampleVideoFrames({ bytes: new Uint8Array(readFileSync(clip)), durationMs: 3_000, count: 4 });
    assert.equal(result.unavailable, undefined);
    assert.equal(result.frames.length, sampleTimestamps(3_000, 4).length, "every sample decodes");
    for (const frame of result.frames) assert.ok(isPng(frame.bytes), `frame at ${frame.timestampMs}ms is a PNG`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
