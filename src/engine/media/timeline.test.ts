import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineError } from "../contracts/errors.ts";
import {
  brightnessArgs,
  envelopeFromPcm,
  loudnessArgs,
  motionArgs,
  parseLoudnessSeries,
  parseSignalSeries,
  pcmArgs,
} from "../../../functions/ffmpeg/timeline.ts";
import { timelineInProcess, timelineOverWire, TIMELINE_PATH } from "./timeline.ts";
import { ffmpegSkipReason, reelPath } from "../test/media-fixture.ts";
import { readFileSync } from "node:fs";
import { TIMELINE_STEPS } from "../../../functions/ffmpeg/types.ts";

const SKIP = ffmpegSkipReason() ?? false;

// Lines as ffmpeg 6.1 prints them for the metadata filter (captured on this build; see analyze/test/fixtures/README.md).
const SIGNAL_LINES = [
  "[Parsed_metadata_2 @ 0x5556441287c0] frame:0    pts:0       pts_time:0",
  "[Parsed_metadata_2 @ 0x5556441287c0] lavfi.signalstats.YAVG=81",
  "[Parsed_metadata_2 @ 0x5556441287c0] frame:1    pts:1       pts_time:0.5",
  "[Parsed_metadata_2 @ 0x5556441287c0] lavfi.signalstats.YAVG=40.5",
].join("\n");

const LOUDNESS_LINES = [
  "[Parsed_ametadata_1 @ 0x55daed542340] frame:0    pts:0       pts_time:0",
  "[Parsed_ametadata_1 @ 0x55daed542340] lavfi.r128.M=-120.691",
  "[Parsed_ametadata_1 @ 0x55daed542340] frame:1    pts:4410    pts_time:0.1",
  "[Parsed_ametadata_1 @ 0x55daed542340] lavfi.r128.M=-23.4",
  "[Parsed_ametadata_1 @ 0x55daed542340] frame:2    pts:8820    pts_time:0.2",
  "[Parsed_ametadata_1 @ 0x55daed542340] lavfi.r128.M=-inf",
].join("\n");

describe("the timeline's arguments (pure)", () => {
  it("samples brightness and motion two times a second, on a 160 px copy, with no audio", () => {
    const brightness = brightnessArgs("/tmp/in.media").join(" ");
    const motion = motionArgs("/tmp/in.media").join(" ");
    assert.match(brightness, /fps=2,scale=160:-2,signalstats/);
    assert.match(brightness, /-an/);
    assert.match(motion, /tblend=all_mode=difference,signalstats/);
  });

  it("reads momentary loudness and a mono 8 kHz PCM envelope", () => {
    assert.match(
      loudnessArgs("/tmp/in.media").join(" "),
      /ebur128=metadata=1.*ametadata=mode=print:key=lavfi\.r128\.M/,
    );
    const pcm = pcmArgs("/tmp/in.media");
    assert.equal(pcm[pcm.indexOf("-ar") + 1], String(TIMELINE_STEPS.envelopeSampleRateHz));
    assert.equal(pcm[pcm.indexOf("-ac") + 1], "1");
    assert.equal(pcm.at(-1), "pipe:1");
  });
});

describe("parsing the metadata series (pure, on recorded ffmpeg lines)", () => {
  it("reads brightness as a 0 to 1 value at each frame time", () => {
    assert.deepEqual(parseSignalSeries(SIGNAL_LINES, 255), [
      { atMs: 0, value: 81 / 255 },
      { atMs: 500, value: 40.5 / 255 },
    ]);
  });

  it("reads momentary loudness, with silence and values under the gate as null", () => {
    assert.deepEqual(parseLoudnessSeries(LOUDNESS_LINES), [
      { atMs: 0, lufs: null },
      { atMs: 100, lufs: -23.4 },
      { atMs: 200, lufs: null },
    ]);
  });

  it("refuses a value with no time, or a time with no value, rather than shortening the series", () => {
    assert.throws(
      () => parseSignalSeries("lavfi.signalstats.YAVG=81", 255),
      (error: unknown) => error instanceof EngineError && error.kind === "provider",
    );
    assert.throws(
      () => parseSignalSeries("frame:0    pts:0       pts_time:0", 255),
      (error: unknown) => error instanceof EngineError && /no value line/.test(error.message),
    );
  });
});

describe("the RMS envelope (pure)", () => {
  it("is the RMS of each 10 ms window of mono 16-bit PCM at 8 kHz, and silence is 0", () => {
    const samples = 8000 / 2; // half a second of PCM
    const pcm = new Uint8Array(samples * 2);
    const view = new DataView(pcm.buffer);
    for (let index = 0; index < samples; index++)
      view.setInt16(index * 2, index < 2000 ? 16384 : 0, true);
    const rms = envelopeFromPcm(pcm);
    assert.equal(rms.length, 50, "one value per 10 ms");
    assert.ok(
      Math.abs((rms[0] ?? 0) - 0.5) < 1e-3,
      "a constant half-scale signal has an RMS of 0.5",
    );
    assert.equal(rms[49], 0);
  });

  it("ignores an odd trailing byte and any partial window", () => {
    assert.equal(
      envelopeFromPcm(new Uint8Array(81)).length,
      0,
      "one sample is not a whole 10 ms window",
    );
  });
});

describe("the timeline client (recorded answers)", () => {
  const good = {
    videoPresent: true,
    audioPresent: true,
    brightness: [
      { atMs: 0, value: 0.3 },
      { atMs: 500, value: 0.2 },
    ],
    motion: [{ atMs: 500, value: 0.1 }],
    loudness: [{ atMs: 0, lufs: null }],
    envelope: { stepMs: 10, rms: [0.1, 0.2] },
  };

  it("posts the source to the timeline route and returns the validated answer", async () => {
    const posts: Array<{ path: string; timeoutMs: number }> = [];
    const client = timelineOverWire(async (path, _body, schema, timeoutMs) => {
      posts.push({ path, timeoutMs });
      return schema.parse(good);
    });
    const result = await client({
      source: { kind: "url", url: "https://media.example.test/reel.mp4" },
    });
    assert.equal(result.brightness.length, 2);
    assert.deepEqual(posts, [{ path: TIMELINE_PATH, timeoutMs: 300_000 }]);
  });

  it("refuses an answer whose brightness does not run forward in time", async () => {
    const client = timelineOverWire(async (_path, _body, schema) =>
      schema.parse({
        ...good,
        brightness: [
          { atMs: 500, value: 0.2 },
          { atMs: 0, value: 0.3 },
        ],
      }),
    );
    await assert.rejects(
      client({ source: { kind: "url", url: "https://media.example.test/reel.mp4" } }),
      (error: unknown) => error instanceof EngineError && error.kind === "provider",
    );
  });

  it("refuses an answer that reports a video stream but measured no brightness", async () => {
    const client = timelineOverWire(async (_path, _body, schema) =>
      schema.parse({ ...good, brightness: [] }),
    );
    await assert.rejects(
      client({ source: { kind: "url", url: "https://media.example.test/reel.mp4" } }),
      /no brightness/,
    );
  });

  it("refuses an answer with an out-of-range value at the schema", async () => {
    const client = timelineOverWire(async (_path, _body, schema) =>
      schema.parse({ ...good, motion: [{ atMs: 500, value: 1.5 }] }),
    );
    await assert.rejects(
      client({ source: { kind: "url", url: "https://media.example.test/reel.mp4" } }),
    );
  });
});

describe("the timeline on a real reel (ffmpeg, skipped without it)", { skip: SKIP }, () => {
  it("measures a 3 s reel: samples at the step, a loudness per 100 ms, and an envelope of the audio", async () => {
    const bytes = new Uint8Array(readFileSync(await reelPath()));
    const result = await timelineInProcess()({ source: { kind: "bytes", bytes } });
    assert.equal(result.videoPresent, true);
    assert.equal(result.audioPresent, true);
    assert.ok(
      result.brightness.length >= 5 && result.brightness.length <= 7,
      `brightness samples: ${result.brightness.length}`,
    );
    assert.ok(result.loudness.length >= 25, `loudness samples: ${result.loudness.length}`);
    assert.ok(result.envelope.rms.length >= 290, `envelope windows: ${result.envelope.rms.length}`);
    assert.ok(result.brightness.every((sample) => sample.value >= 0 && sample.value <= 1));
  });
});
