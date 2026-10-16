// probe: the pure parser and argument builder, tested on recorded ffprobe output (no tool is run here).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError } from "../contracts/errors.ts";
import { buildArgs, parse } from "../../../functions/ffmpeg/probe.ts";
import { RECORDED_FFPROBE_REEL_JSON } from "../test/fixtures/recorded/ffmpeg-output.ts";

const REEL_BYTES = 346808;

describe("probe.parse on recorded ffprobe output", () => {
  it("reports the generated reel exactly: container, codecs, size, frame rate, duration and audio", () => {
    const result = parse(RECORDED_FFPROBE_REEL_JSON, REEL_BYTES);
    assert.deepEqual(result, {
      container: "mov,mp4,m4a,3gp,3g2,mj2",
      videoCodec: "h264",
      audioCodec: "aac",
      width: 1080,
      height: 1920,
      fps: { num: 30, den: 1, value: 30 },
      durationMs: 3000,
      audioPresent: true,
      bytes: REEL_BYTES,
    });
  });

  it("takes the byte count from the file that was probed, not from the tool", () => {
    assert.equal(parse(RECORDED_FFPROBE_REEL_JSON, 123).bytes, 123);
  });

  it("reads the frame rate as a rational, falling back to r_frame_rate when avg_frame_rate is 0/0", () => {
    const json = JSON.parse(RECORDED_FFPROBE_REEL_JSON) as {
      streams: Array<Record<string, unknown>>;
    };
    const video = json.streams.find((stream) => stream.codec_type === "video") as Record<
      string,
      unknown
    >;
    video.avg_frame_rate = "0/0";
    video.r_frame_rate = "30000/1001";
    const result = parse(JSON.stringify(json), REEL_BYTES);
    assert.deepEqual(result.fps, { num: 30000, den: 1001, value: 30000 / 1001 });
  });

  it("returns null for an unknown frame rate instead of guessing", () => {
    const json = JSON.parse(RECORDED_FFPROBE_REEL_JSON) as {
      streams: Array<Record<string, unknown>>;
    };
    const video = json.streams.find((stream) => stream.codec_type === "video") as Record<
      string,
      unknown
    >;
    video.avg_frame_rate = "0/0";
    video.r_frame_rate = "0/0";
    assert.equal(parse(JSON.stringify(json), REEL_BYTES).fps, null);
  });

  it("reports no audio when there is no audio stream", () => {
    const json = JSON.parse(RECORDED_FFPROBE_REEL_JSON) as {
      streams: Array<Record<string, unknown>>;
    };
    json.streams = json.streams.filter((stream) => stream.codec_type !== "audio");
    const result = parse(JSON.stringify(json), REEL_BYTES);
    assert.equal(result.audioPresent, false);
    assert.equal(result.audioCodec, null);
  });

  it("skips an attached cover picture when choosing the video stream", () => {
    const json = JSON.parse(RECORDED_FFPROBE_REEL_JSON) as {
      streams: Array<Record<string, unknown>>;
    };
    const video = json.streams.find((stream) => stream.codec_type === "video") as Record<
      string,
      unknown
    >;
    const cover = {
      ...video,
      codec_name: "mjpeg",
      width: 300,
      height: 300,
      disposition: { attached_pic: 1 },
    };
    json.streams.unshift(cover);
    const result = parse(JSON.stringify(json), REEL_BYTES);
    assert.equal(result.videoCodec, "h264");
    assert.equal(result.width, 1080);
  });

  it("refuses output that is not JSON as a provider error", () => {
    assert.throws(
      () => parse("not json", REEL_BYTES),
      (error: unknown) =>
        error instanceof EngineError && error.kind === "provider" && error.retryable === false,
    );
  });

  it("refuses JSON with no streams as invalid input: there is no media to describe", () => {
    assert.throws(
      () => parse(JSON.stringify({ format: { format_name: "x" }, streams: [] }), REEL_BYTES),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
  });
});

describe("probe.buildArgs", () => {
  it("asks ffprobe for JSON with the format and every stream, on the given file only", () => {
    assert.deepEqual(buildArgs({ inputPath: "/tmp/x/input.media" }), [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      "-i",
      "/tmp/x/input.media",
    ]);
  });
});
