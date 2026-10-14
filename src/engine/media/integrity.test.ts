// render_integrity (Bible 6.11, 12.3): pure checks of a probe against an EDL. Unknown values fail.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProbeResult } from "../../../functions/ffmpeg/types.ts";
import { edlFixture, renderedVideoFixture } from "../contracts/fixtures/index.ts";
import { gateResultSchema } from "../contracts/gate.ts";
import {
  checkRenderIntegrity,
  integrityLimitsFromConfig,
  type IntegrityLimits,
} from "./integrity.ts";

const LIMITS: IntegrityLimits = { durationToleranceMs: 100, platformMaxBytes: 50_000_000 };

/** A render that matches the EDL fixture exactly: 24000 ms, 1080 x 1920, 30 fps, H.264 and AAC, 6.4 MB. */
function goodProbe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    videoCodec: "h264",
    audioCodec: "aac",
    width: 1080,
    height: 1920,
    fps: { num: 30, den: 1, value: 30 },
    durationMs: edlFixture.durationMs,
    audioPresent: true,
    bytes: renderedVideoFixture.bytes,
    ...overrides,
  };
}

function check(probe: ProbeResult, limits: IntegrityLimits = LIMITS) {
  return checkRenderIntegrity(
    { videoId: renderedVideoFixture.videoId, probe, edl: edlFixture },
    limits,
  );
}

function failing(probe: ProbeResult, limits: IntegrityLimits = LIMITS): string[] {
  return check(probe, limits)
    .checks.filter((item) => !item.pass)
    .map((item) => item.rule);
}

describe("checkRenderIntegrity", () => {
  it("passes a render that matches its EDL, and returns a valid render_integrity GateResult", () => {
    const result = check(goodProbe());
    assert.equal(result.pass, true);
    assert.equal(result.gate, "render_integrity");
    assert.equal(result.subjectId, renderedVideoFixture.videoId);
    assert.deepEqual(gateResultSchema.parse(result), result);
  });

  it("accepts a duration exactly 100 ms away from the EDL and rejects 101 ms (Bible 6.11)", () => {
    assert.deepEqual(failing(goodProbe({ durationMs: edlFixture.durationMs + 100 })), []);
    assert.deepEqual(failing(goodProbe({ durationMs: edlFixture.durationMs - 100 })), []);
    assert.deepEqual(failing(goodProbe({ durationMs: edlFixture.durationMs + 101 })), [
      "duration_matches_edl",
    ]);
  });

  it("fails an unknown duration rather than passing it", () => {
    assert.deepEqual(failing(goodProbe({ durationMs: null })), ["duration_matches_edl"]);
  });

  it("fails a frame rate of 29.97 and accepts 30 written as 60/2", () => {
    assert.deepEqual(failing(goodProbe({ fps: { num: 30000, den: 1001, value: 29.97 } })), ["fps"]);
    assert.deepEqual(failing(goodProbe({ fps: { num: 60, den: 2, value: 30 } })), []);
  });

  it("fails an unknown frame rate", () => {
    assert.deepEqual(failing(goodProbe({ fps: null })), ["fps"]);
  });

  it("fails a resolution other than 1080 x 1920", () => {
    assert.deepEqual(failing(goodProbe({ width: 1280, height: 720 })), ["resolution"]);
  });

  it("fails a video codec other than H.264, and an audio codec other than AAC", () => {
    assert.deepEqual(failing(goodProbe({ videoCodec: "hevc" })), ["video_codec_h264"]);
    assert.deepEqual(failing(goodProbe({ audioCodec: "mp3" })), ["audio_codec_aac"]);
  });

  it("fails a render with no audio", () => {
    assert.deepEqual(failing(goodProbe({ audioPresent: false, audioCodec: null })), [
      "audio_codec_aac",
      "audio_present",
    ]);
  });

  it("fails when the platform size limit is not set (null): the size cannot be judged (Bible 12)", () => {
    const result = check(goodProbe(), { durationToleranceMs: 100, platformMaxBytes: null });
    assert.equal(result.pass, false);
    const size = result.checks.find((item) => item.rule === "size_under_platform_limit");
    assert.equal(size?.pass, false);
    assert.match(size?.detail ?? "", /not set \(null\)/);
  });

  it("fails a file larger than the platform limit, and passes one equal to it", () => {
    assert.deepEqual(failing(goodProbe({ bytes: 50_000_001 })), ["size_under_platform_limit"]);
    assert.deepEqual(failing(goodProbe({ bytes: 50_000_000 })), []);
  });

  it("fails an unknown file size", () => {
    assert.deepEqual(failing(goodProbe({ bytes: null })), ["size_under_platform_limit"]);
  });

  it("reads the duration tolerance and the size limit from configuration by default", () => {
    const limits = integrityLimitsFromConfig();
    assert.equal(limits.durationToleranceMs, 100);
    assert.equal(limits.platformMaxBytes, null);
  });
});
