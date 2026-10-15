// The detectors (Bible 6.7 step 1, 12.2, 12.3). The parsers and the scores are tested on the lines this ffmpeg build prints (6.1.1,
// captured on a generated 3 s clip, see test/detector-clips.ts), and on exact synthetic series. The functions are then run on the
// generated clips when ffmpeg is installed (skipped with a visible reason otherwise). No test calls a live API.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  blackFramesArgs,
  flickerScoreOf,
  lumaArgs,
  meanMotionOf,
  motionEnergyArgs,
  parseSpans,
  silenceArgs,
} from "../../../functions/ffmpeg/detectors.ts";
import { EngineError } from "../contracts/errors.ts";
import { detectorsInProcess, detectorsOverWire, DETECTOR_PATHS } from "./detectors.ts";
import { ffmpegSkipReason } from "../test/media-fixture.ts";
import { detectorClipBytes, DETECTOR_CLIP, clipArgs } from "./test/detector-clips.ts";
import { blackFramesResultSchema, silenceResultSchema } from "../../../functions/ffmpeg/types.ts";
import { sourceToWire } from "../../../functions/ffmpeg/wire.ts";

const BLACK_REPORT =
  "[blackdetect @ 0x7f8abc001100] black_start:1 black_end:1.5 black_duration:0.5";
const FREEZE_REPORT = [
  "[freezedetect @ 0x55e0a963f400] lavfi.freezedetect.freeze_start: 0",
  "[freezedetect @ 0x55e0a963f400] lavfi.freezedetect.freeze_duration: 1",
  "[freezedetect @ 0x55e0a963f400] lavfi.freezedetect.freeze_end: 1",
  "[freezedetect @ 0x55e0a963f400] lavfi.freezedetect.freeze_start: 1",
  "[freezedetect @ 0x55e0a963f400] lavfi.freezedetect.freeze_duration: 0.5",
  "[freezedetect @ 0x55e0a963f400] lavfi.freezedetect.freeze_end: 1.5",
  "[freezedetect @ 0x55e0a963f400] lavfi.freezedetect.freeze_start: 1.5",
].join("\n");
const SILENCE_REPORT = [
  "[silencedetect @ 0x55aa3a386ac0] silence_start: 1.0001",
  "[silencedetect @ 0x55aa3a386ac0] silence_end: 2.00002 | silence_duration: 0.999917",
].join("\n");

function providerRefusal(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof EngineError, `expected an EngineError, got ${String(error)}`);
    assert.equal(error.kind, "provider");
    assert.match(error.message, pattern);
    return true;
  });
}

describe("parseSpans on the recorded reports (ffmpeg 6.1.1)", () => {
  it("reads one black run from blackdetect, in milliseconds", () => {
    assert.deepEqual(parseSpans(BLACK_REPORT, "black", 3000), [
      { startMs: 1000, endMs: 1500, durationMs: 500 },
    ]);
  });

  it("reads the freeze runs, and closes the one still open at the end at the probed duration", () => {
    assert.deepEqual(parseSpans(FREEZE_REPORT, "freeze", 3000), [
      { startMs: 0, endMs: 1000, durationMs: 1000 },
      { startMs: 1000, endMs: 1500, durationMs: 500 },
      { startMs: 1500, endMs: 3000, durationMs: 1500 },
    ]);
  });

  it("reads the silence from silencedetect, to the millisecond", () => {
    assert.deepEqual(parseSpans(SILENCE_REPORT, "silence", 3000), [
      { startMs: 1000, endMs: 2000, durationMs: 1000 },
    ]);
  });

  it("reports nothing for a report with no lines of its kind", () => {
    assert.deepEqual(parseSpans("no detector lines here", "black", 1000), []);
  });

  it("closes an open span at the duration, and refuses it when the duration is unknown", () => {
    assert.deepEqual(parseSpans("black_start:2", "black", 2500), [
      { startMs: 2000, endMs: 2500, durationMs: 500 },
    ]);
    providerRefusal(
      () => parseSpans("black_start:2", "black", null),
      /open at the end and the media duration is unknown/,
    );
  });

  it("refuses a report whose spans are not a start followed by an end, instead of repairing it", () => {
    providerRefusal(
      () => parseSpans("black_end:1.5", "black", 3000),
      /ends a span that never started/,
    );
    providerRefusal(
      () => parseSpans("black_start:1\nblack_start:2\nblack_end:2.5", "black", 3000),
      /starts a span inside an open span/,
    );
    providerRefusal(
      () => parseSpans("black_start:2 black_end:1", "black", 3000),
      /ends a span before it starts/,
    );
    providerRefusal(
      () => parseSpans("black_start:x black_end:1", "black", 3000),
      /not a non-negative number/,
    );
  });

  it("refuses overlapping spans", () => {
    providerRefusal(
      () => parseSpans("black_start:1 black_end:2\nblack_start:1.5 black_end:3", "black", 4000),
      /starts a span inside an open span|overlap/,
    );
  });
});

describe("the flicker score (Bible 12.2, normalised)", () => {
  it("is 1 for a picture that alternates brightness on every frame", () => {
    const luma = Array.from({ length: 30 }, (_, index) => (index % 2 === 0 ? 60 / 255 : 200 / 255));
    assert.equal(flickerScoreOf(luma), 1);
  });

  it("is 0 for a steady picture, and for a smooth fade", () => {
    assert.equal(flickerScoreOf(Array.from({ length: 30 }, () => 0.5)), 0);
    // A constant step leaves reversals of floating-point noise only (about 1e-17), which is zero for any purpose.
    const fade = flickerScoreOf(Array.from({ length: 30 }, (_, index) => index / 60));
    assert.ok(fade !== null && fade < 1e-9, `fade ${fade}`);
  });

  it("scores a small alternation in proportion: six levels on the 0 to 255 scale is about 0.47", () => {
    const luma = Array.from({ length: 30 }, (_, index) => (index % 2 === 0 ? 120 : 126) / 255);
    const score = flickerScoreOf(luma);
    assert.ok(score !== null && score > 0.4 && score < 0.55, `score ${score}`);
  });

  it("is not moved by a single cut: the largest reversals are dropped before the mean", () => {
    const luma = Array.from({ length: 60 }, (_, index) => (index < 30 ? 0.3 : 0.7));
    assert.equal(flickerScoreOf(luma), 0);
  });

  it("is null with fewer than three frames, since no reversal can be seen", () => {
    assert.equal(flickerScoreOf([0.1, 0.9]), null);
    assert.equal(flickerScoreOf([]), null);
  });
});

describe("the motion mean and the report arguments (pure)", () => {
  it("averages the motion series, and is null with no values", () => {
    assert.equal(meanMotionOf([]), null);
    assert.equal(meanMotionOf([0.1, 0.2]), 0.15000000000000002);
  });

  it("builds one pass for black and freeze, with the thresholds from DETECT_STEPS and no audio", () => {
    const args = blackFramesArgs("/tmp/in.mp4").join(" ");
    assert.match(args, /blackdetect=d=0\.001:pix_th=0\.1:pic_th=0\.98/);
    assert.match(args, /freezedetect=n=0\.001:d=0\.001/);
    assert.match(args, /-map 0:v:0 -an/);
  });

  it("builds the luma and motion passes on every frame, and silencedetect at the analyze floor", () => {
    assert.match(lumaArgs("/tmp/in.mp4").join(" "), /scale=160:-2,signalstats,metadata=mode=print/);
    assert.match(
      motionEnergyArgs("/tmp/in.mp4").join(" "),
      /tblend=all_mode=difference,signalstats/,
    );
    assert.match(silenceArgs("/tmp/in.mp4").join(" "), /silencedetect=noise=-50dB:d=0\.1/);
  });
});

describe("the detector clients (contract, routes and the wire)", () => {
  it("sends each detector to its own path, with the source as base64 and the source's timeout", async () => {
    const calls: Array<{ path: string; body: unknown; timeoutMs: number }> = [];
    const source = { kind: "bytes" as const, bytes: new Uint8Array([1, 2, 3]) };
    const fake = detectorsOverWire(async (path, body, schema, timeoutMs) => {
      calls.push({ path, body, timeoutMs });
      // A stand-in answer: the call is what is under test, so the answer is the schema's minimal valid value.
      return schema.parse(
        path === DETECTOR_PATHS.blackFrames
          ? { videoPresent: false, durationMs: null, fps: null, blackRuns: [], frozenRuns: [] }
          : path === DETECTOR_PATHS.silence
            ? {
                audioPresent: false,
                durationMs: null,
                minSilenceMs: 100,
                silences: [],
                longestMs: null,
              }
            : path === DETECTOR_PATHS.flicker
              ? { videoPresent: false, frames: 0, flickerScore: null }
              : { videoPresent: false, frames: 0, meanMotion: null },
      );
    });
    await fake.blackFrames({ source });
    await fake.flicker({ source });
    await fake.motion({ source });
    await fake.silence({ source });
    assert.deepEqual(
      calls.map((call) => call.path),
      ["/black", "/flicker", "/motion", "/silence"],
    );
    assert.deepEqual(calls[0]?.body, { source: sourceToWire(source) });
    assert.equal(calls[0]?.timeoutMs, 200_000);
    assert.equal(calls[3]?.timeoutMs, 140_000);
  });

  it("refuses inline media above the inline limit before any request is sent: it must be passed by URL", async () => {
    let sent = 0;
    const fake = detectorsOverWire(async () => {
      sent += 1;
      throw new Error("not expected");
    });
    const oversize = { kind: "bytes" as const, bytes: new Uint8Array(4 * 1024 * 1024 + 1) };
    await assert.rejects(
      () => fake.motion({ source: oversize }),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
    assert.equal(sent, 0);
  });

  it("accepts only a result that matches its schema: an answer with a stray key is refused", () => {
    assert.equal(
      blackFramesResultSchema.safeParse({
        videoPresent: true,
        durationMs: 3000,
        fps: 30,
        blackRuns: [],
        frozenRuns: [],
        note: "extra",
      }).success,
      false,
    );
    assert.equal(
      silenceResultSchema.safeParse({
        audioPresent: true,
        durationMs: 3000,
        minSilenceMs: 100,
        silences: [{ startMs: 1000, endMs: 2000, durationMs: 1000 }],
        longestMs: 500,
      }).success,
      false,
      "the longest silence must be the longest run",
    );
  });

  it("the in-process form refuses a request with no source", async () => {
    await assert.rejects(
      () => detectorsInProcess().flicker({} as never),
      (error: unknown) => error instanceof EngineError && error.kind === "invalid_input",
    );
  });
});

describe(
  "the detectors on generated clips (real ffmpeg)",
  { skip: ffmpegSkipReason() ?? false },
  () => {
    it("black-gap: finds the black block at 1000 to 1500 ms within one frame, and the frozen block of the yellow", async () => {
      const media = detectorsInProcess();
      const source = { kind: "bytes" as const, bytes: await detectorClipBytes("black-gap") };
      const black = await media.blackFrames({ source });
      assert.equal(black.videoPresent, true);
      assert.equal(black.fps, 30);
      assert.equal(black.blackRuns.length, 1, JSON.stringify(black.blackRuns));
      const [run] = black.blackRuns;
      const frame = 1000 / DETECTOR_CLIP.fps;
      assert.ok(
        Math.abs((run?.startMs ?? 0) - DETECTOR_CLIP.blackStartMs) <= frame,
        `start ${run?.startMs}`,
      );
      assert.ok(
        Math.abs((run?.endMs ?? 0) - DETECTOR_CLIP.blackEndMs) <= frame,
        `end ${run?.endMs}`,
      );
      // The yellow block is a frozen run of 1.5 s, closed at the end of the media. That is more than two frames.
      const frozen = black.frozenRuns.find((item) => item.startMs >= 1400);
      assert.ok(
        frozen !== undefined && frozen.durationMs >= 1400,
        JSON.stringify(black.frozenRuns),
      );
    });

    it("steady: a flat picture is frozen and never black", async () => {
      const source = { kind: "bytes" as const, bytes: await detectorClipBytes("steady") };
      const black = await detectorsInProcess().blackFrames({ source });
      assert.deepEqual(black.blackRuns, []);
      assert.equal(black.frozenRuns.length, 1);
      assert.equal(black.frozenRuns[0]?.durationMs, 2000);
    });

    it("flicker: an alternating picture scores at least 0.9, and a steady one scores 0", async () => {
      const media = detectorsInProcess();
      const flicker = await media.flicker({
        source: { kind: "bytes", bytes: await detectorClipBytes("flicker") },
      });
      assert.ok(
        flicker.flickerScore !== null && flicker.flickerScore >= 0.9,
        JSON.stringify(flicker),
      );
      const steady = await media.flicker({
        source: { kind: "bytes", bytes: await detectorClipBytes("steady") },
      });
      assert.equal(steady.flickerScore, 0);
      assert.equal(steady.frames, 60, "one value per frame at 30 fps for 2 s");
    });

    it("motion: a panning picture is above 0.05, and a still picture is 0", async () => {
      const media = detectorsInProcess();
      const pan = await media.motion({
        source: { kind: "bytes", bytes: await detectorClipBytes("pan") },
      });
      assert.ok(pan.meanMotion !== null && pan.meanMotion > 0.05, JSON.stringify(pan));
      const still = await media.motion({
        source: { kind: "bytes", bytes: await detectorClipBytes("steady") },
      });
      assert.equal(still.meanMotion, 0);
    });

    it("silence: the silent second of the tone-gap clip is found to the frame, and the longest silence is about one second", async () => {
      const silence = await detectorsInProcess().silence({
        source: { kind: "bytes", bytes: await detectorClipBytes("tone-gap") },
      });
      assert.equal(silence.audioPresent, true);
      assert.equal(silence.silences.length, 1, JSON.stringify(silence.silences));
      const [run] = silence.silences;
      assert.ok(
        Math.abs((run?.startMs ?? 0) - DETECTOR_CLIP.silenceStartMs) <= 100,
        `start ${run?.startMs}`,
      );
      assert.ok(
        Math.abs((run?.endMs ?? 0) - DETECTOR_CLIP.silenceEndMs) <= 100,
        `end ${run?.endMs}`,
      );
      assert.ok(Math.abs((silence.longestMs ?? 0) - 1000) <= 100, `longest ${silence.longestMs}`);
    });

    it("a clip with no audio stream says so: no audio, and no longest silence (never a zero)", async () => {
      const source = { kind: "bytes" as const, bytes: await detectorClipBytes("no-audio") };
      const silence = await detectorsInProcess().silence({ source });
      assert.equal(silence.audioPresent, false);
      assert.equal(silence.longestMs, null);
      assert.deepEqual(silence.silences, []);
    });

    it("the generated clips have the arguments the tests describe (the generator is pure)", () => {
      assert.match(clipArgs("tone-gap", "/tmp/x.mp4").join(" "), /concat=n=3:v=0:a=1/);
    });
  },
);
