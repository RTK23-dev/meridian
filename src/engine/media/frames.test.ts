// frames: the frame plan of Bible 6.2 (pure), the PNG structure check, and the frame argument builder and parser.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PNG } from "pngjs";
import { EngineError } from "../contracts/errors.ts";
import {
  buildArgs,
  frameFileName,
  parse as parseFrames,
  scaleFor,
} from "../../../functions/ffmpeg/frames.ts";
import { readPngSize } from "../../../functions/ffmpeg/png.ts";
import { planFrameTimes, decodeFramesResponse } from "./frames.ts";
import { mediaConfig } from "./config.ts";
import { thresholds } from "../config/thresholds.ts";

function pngBytes(width: number, height: number): Uint8Array<ArrayBuffer> {
  const png = new PNG({ width, height });
  png.data.fill(128);
  return Uint8Array.from(PNG.sync.write(png));
}

const BASE = { framesPerSecond: 2, maxFrames: 60, frameMs: 1000 / 30 };

describe("planFrameTimes (Bible 6.2: every cut, plus 2 per second, capped at 60)", () => {
  it("takes a frame at every cut and at the midpoint of each half second", () => {
    const plan = planFrameTimes({ ...BASE, durationMs: 3000, cutsMs: [1000, 2000] });
    assert.deepEqual(plan.atMs, [250, 750, 1000, 1250, 1750, 2000, 2250, 2750]);
    assert.equal(plan.cutsCovered, true);
    assert.equal(plan.droppedSamples, 0);
  });

  it("drops a sample that coincides with a cut, since the cut already has its frame", () => {
    // Samples of a 1 s video at 2 per second are 250 and 750. A cut at 250 takes the place of the first sample.
    const plan = planFrameTimes({ ...BASE, durationMs: 1000, cutsMs: [250] });
    assert.deepEqual(plan.atMs, [250, 750]);
  });

  it("never plans a frame at or past the last frame of the video", () => {
    // A cut at the very end has no frame; a cut at 0 does.
    const plan = planFrameTimes({ ...BASE, durationMs: 1000, cutsMs: [1000, 0] });
    assert.deepEqual(plan.atMs, [0, 250, 750]);
  });

  it("caps the frames at 60 and keeps the cuts first, so a 40-cut video keeps every cut and fewer samples", () => {
    const cuts = Array.from({ length: 40 }, (_, i) => (i + 1) * 500);
    const plan = planFrameTimes({ ...BASE, durationMs: 60_000, cutsMs: cuts });
    assert.equal(plan.atMs.length, 60);
    assert.equal(plan.cutsCovered, true);
    for (const cut of cuts) {
      assert.ok(plan.atMs.includes(cut), `cut ${cut} must keep its frame`);
    }
    assert.ok(plan.droppedSamples > 0);
  });

  it("reports that cuts are not covered when the cuts alone exceed the cap, and thins them evenly", () => {
    const cuts = Array.from({ length: 70 }, (_, i) => (i + 1) * 300);
    const plan = planFrameTimes({ ...BASE, durationMs: 30_000, cutsMs: cuts });
    assert.equal(plan.atMs.length, 60);
    assert.equal(plan.cutsCovered, false);
    assert.equal(plan.droppedCuts, 10);
    assert.ok(
      plan.atMs.every((ms) => cuts.includes(ms)),
      "no sample is kept once the cap is used by cuts",
    );
  });

  it("uses the Bible values from configuration by default", () => {
    const plan = planFrameTimes({
      durationMs: 3000,
      cutsMs: [],
      framesPerSecond: thresholds.reference.framesPerSecond,
      maxFrames: thresholds.reference.maxFrames,
      frameMs: mediaConfig.frameMs,
    });
    assert.equal(plan.atMs.length, 6);
    assert.equal(thresholds.reference.maxFrames, 60);
  });

  it("returns an empty plan for a video shorter than one frame", () => {
    const plan = planFrameTimes({ ...BASE, durationMs: 20, cutsMs: [] });
    assert.deepEqual(plan.atMs, []);
  });
});

describe("readPngSize (the PNG structure check)", () => {
  it("reads the size of a well-formed PNG", () => {
    assert.deepEqual(readPngSize(pngBytes(432, 768)), { width: 432, height: 768 });
  });

  it("rejects bytes that are not a PNG", () => {
    assert.equal(readPngSize(new Uint8Array(64).fill(7)), null);
    assert.equal(readPngSize(new Uint8Array(4)), null);
  });

  it("rejects a PNG without its IEND chunk, which is a truncated file", () => {
    const whole = pngBytes(8, 8);
    assert.equal(readPngSize(whole.subarray(0, whole.byteLength - 4)), null);
  });

  it("rejects a PNG whose header claims zero pixels", () => {
    const bytes = pngBytes(8, 8);
    new DataView(bytes.buffer).setUint32(16, 0);
    assert.equal(readPngSize(bytes), null);
  });
});

describe("scaleFor", () => {
  it("scales a 1080 x 1920 frame to a 768 px long side, keeping the aspect ratio with even sides", () => {
    assert.deepEqual(scaleFor(1080, 1920, 768), { width: 432, height: 768 });
  });

  it("returns null when the frame is already no longer than the limit: no upscaling", () => {
    assert.equal(scaleFor(1080, 1920, 2160), null);
  });
});

describe("frames.buildArgs and parse", () => {
  it("writes one output per time, each seeking to its time after the input, in request order", () => {
    const args = buildArgs({
      inputPath: "/tmp/x/input.media",
      atMs: [500, 1500],
      outDir: "/tmp/x/frames",
      scale: null,
    });
    const seeks = args.flatMap((arg, i) => (arg === "-ss" ? [args[i + 1]] : []));
    assert.deepEqual(seeks, ["0.500", "1.500"]);
    assert.ok(
      args.indexOf("-ss") > args.indexOf("-i"),
      "output seeking, after -i, is frame accurate",
    );
    assert.equal(args.at(-1), "/tmp/x/frames/" + frameFileName(1));
  });

  it("adds a scale filter to every output when a scale is set", () => {
    const args = buildArgs({
      inputPath: "a",
      atMs: [0, 1000],
      outDir: "d",
      scale: { width: 432, height: 768 },
    });
    assert.equal(args.filter((arg) => arg === "scale=432:768").length, 2);
  });

  it("pairs each time with its PNG and reports the PNG size", () => {
    const frames = parseFrames([500], [pngBytes(432, 768)]);
    assert.deepEqual(
      frames.map((frame) => [frame.atMs, frame.width, frame.height]),
      [[500, 432, 768]],
    );
  });

  it("refuses a missing frame as invalid input: the time is past the last frame", () => {
    assert.throws(
      () => parseFrames([2999], [null], "no frame"),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
  });

  it("refuses a file that is not a PNG as a provider error", () => {
    assert.throws(
      () => parseFrames([0], [new Uint8Array([1, 2, 3])]),
      (error: unknown) => error instanceof EngineError && error.kind === "provider",
    );
  });
});

describe("decodeFramesResponse (the wire check on a frames answer)", () => {
  const png = pngBytes(432, 768);
  const pngBase64 = Buffer.from(png).toString("base64");

  it("accepts frames that match the request in order and their declared size", () => {
    const result = decodeFramesResponse(
      { source: { kind: "bytes", bytes: new Uint8Array(1) }, atMs: [1500] },
      { frames: [{ atMs: 1500, width: 432, height: 768, pngBase64 }] },
    );
    assert.equal(result.frames[0]?.png.byteLength, png.byteLength);
  });

  it("refuses a different number of frames than were asked for", () => {
    assert.throws(
      () =>
        decodeFramesResponse(
          { source: { kind: "bytes", bytes: new Uint8Array(1) }, atMs: [1500, 2500] },
          { frames: [{ atMs: 1500, width: 432, height: 768, pngBase64 }] },
        ),
      (error: unknown) => error instanceof EngineError && error.kind === "provider",
    );
  });

  it("refuses frames out of the requested order", () => {
    assert.throws(
      () =>
        decodeFramesResponse(
          { source: { kind: "bytes", bytes: new Uint8Array(1) }, atMs: [1500] },
          { frames: [{ atMs: 900, width: 432, height: 768, pngBase64 }] },
        ),
      (error: unknown) => error instanceof EngineError && error.kind === "provider",
    );
  });

  it("refuses a PNG whose real size differs from the declared size", () => {
    assert.throws(
      () =>
        decodeFramesResponse(
          { source: { kind: "bytes", bytes: new Uint8Array(1) }, atMs: [1500] },
          { frames: [{ atMs: 1500, width: 1080, height: 1920, pngBase64 }] },
        ),
      (error: unknown) => error instanceof EngineError && error.kind === "provider",
    );
  });
});
