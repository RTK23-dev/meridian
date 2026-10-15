// The aggregation of frame_reader's readings into the grammar's caption and motion fields (Bible 6.2 step 6, 8.1). Pure: the
// readings are written by hand to the role's contract. Each null is tested with its reason, since unknown stays unknown.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FrameReading } from "../claude/roles/frame_reader.ts";
import { analyzeConfig } from "./config.ts";
import {
  bandOf,
  captionsOf,
  judgementOf,
  majority,
  selectFrames,
  summariseFrameReadings,
  type TimedReading,
} from "./frameReader.ts";
import type { Frame } from "../media/index.ts";

const config = analyzeConfig.frameReader;

function reading(atMs: number, overrides: Partial<FrameReading> = {}): TimedReading {
  return {
    atMs,
    reading: {
      index: 0,
      confidence: 0.9,
      captions: [],
      overlays: [],
      textWords: 0,
      shake: "none",
      speedRamp: "none",
      ...overrides,
    },
  };
}

const lowerCaption = (words: number, highlight: "one_word" | "none" | "unclear" = "one_word") => ({
  box: { x: 0.1, y: 0.78, w: 0.8, h: 0.07 },
  words,
  style: "outlined" as const,
  highlight,
});

describe("selectFrames: the frames sent to the role (at most its maximum)", () => {
  const frames = (count: number): Frame[] =>
    Array.from({ length: count }, (_, index) => ({
      atMs: index * 100,
      width: 1,
      height: 1,
      png: new Uint8Array([index]),
    }));

  it("returns a list no longer than the maximum whole, in order", () => {
    assert.deepEqual(
      selectFrames(frames(15), 24).map((frame) => frame.atMs),
      frames(15).map((frame) => frame.atMs),
    );
  });

  it("takes an even spread of the maximum, always with the first and the last frame", () => {
    const picked = selectFrames(frames(60), 24);
    assert.equal(picked.length, 24);
    assert.equal(picked[0]?.atMs, 0);
    assert.equal(picked[23]?.atMs, 5900);
    assert.ok(picked.every((frame, index) => index === 0 || frame.atMs > picked[index - 1]!.atMs));
  });
});

describe("captionsOf: the caption block of the grammar (Bible 8.1)", () => {
  it("reads the words, the band, the style and the highlight of the confident frames that show a caption", () => {
    const readings = [0, 1, 2, 3].map((index) =>
      reading(index * 500, { captions: [lowerCaption(index % 2 === 0 ? 2 : 3)] }),
    );
    assert.deepEqual(captionsOf(readings, config), {
      captions: {
        wordsPerCaption: [2, 3],
        position: "lower",
        style: "outlined",
        highlightCurrentWord: true,
      },
      reason: null,
    });
  });

  it("is null, with the count, when fewer than the minimum of confident frames show a caption", () => {
    const readings = [reading(0, { captions: [lowerCaption(2)] }), reading(500), reading(1000)];
    const result = captionsOf(readings, config);
    assert.equal(result.captions, null);
    assert.match(
      result.reason ?? "",
      /fewer than 3 confident frames show a caption \(1 of 3 frames\)/,
    );
  });

  it("ignores a frame the reader is not sure of, so its caption is not counted", () => {
    const readings = [
      reading(0, { captions: [lowerCaption(2)], confidence: 0.2 }),
      reading(500, { captions: [lowerCaption(2)], confidence: 0.2 }),
      reading(1000, { captions: [lowerCaption(2)] }),
      reading(1500, { captions: [lowerCaption(2)] }),
    ];
    assert.equal(captionsOf(readings, config).captions, null);
  });

  it("is null when the band or the style is split between the frames, not a guess", () => {
    const split = [
      reading(0, { captions: [{ ...lowerCaption(2), box: { x: 0.1, y: 0.05, w: 0.8, h: 0.07 } }] }),
      reading(500, { captions: [lowerCaption(2)] }),
      reading(1000, { captions: [lowerCaption(2)] }),
      reading(1500, {
        captions: [{ ...lowerCaption(2), box: { x: 0.1, y: 0.05, w: 0.8, h: 0.07 } }],
      }),
    ];
    assert.equal(captionsOf(split, config).captions, null);
    assert.match(captionsOf(split, config).reason ?? "", /band is split/);
  });

  it("is null when no caption says whether a word is highlighted, and when the highlight is split", () => {
    const unclear = [0, 1, 2].map((index) =>
      reading(index * 500, { captions: [lowerCaption(2, "unclear")] }),
    );
    assert.match(captionsOf(unclear, config).reason ?? "", /says whether one word is highlighted/);
    const split = [
      reading(0, { captions: [lowerCaption(2, "one_word")] }),
      reading(500, { captions: [lowerCaption(2, "none")] }),
      reading(1000, { captions: [lowerCaption(2, "one_word")] }),
      reading(1500, { captions: [lowerCaption(2, "none")] }),
    ];
    assert.match(captionsOf(split, config).reason ?? "", /highlight of the current word is split/);
  });

  it("puts an upper and a middle caption in their bands from the centre of the box", () => {
    assert.equal(bandOf({ y: 0.05, h: 0.1 }, config.captionBand), "upper");
    assert.equal(bandOf({ y: 0.45, h: 0.1 }, config.captionBand), "middle");
    assert.equal(bandOf({ y: 0.8, h: 0.1 }, config.captionBand), "lower");
  });
});

describe("judgementOf: shake and speed ramps as flags (Bible 8.1)", () => {
  it("sets the flag when the share of judged frames that show it reaches the share limit", () => {
    const ten = Array.from({ length: 10 }, (_, index) =>
      reading(index * 500, { shake: index < 3 ? "present" : "none" }),
    );
    assert.deepEqual(
      judgementOf(ten, (item) => item.shake, config.shakeShareMin, config),
      {
        value: true,
        reason: null,
      },
    );
  });

  it("is false when the frames are judged clearly and few of them show it", () => {
    const ten = Array.from({ length: 10 }, (_, index) =>
      reading(index * 500, { shake: index < 1 ? "present" : "none" }),
    );
    assert.deepEqual(
      judgementOf(ten, (item) => item.shake, config.shakeShareMin, config),
      {
        value: false,
        reason: null,
      },
    );
  });

  it("is null, with the count, when fewer than the minimum share of the frames are judged clearly", () => {
    const readings = Array.from({ length: 10 }, (_, index) =>
      reading(index * 500, { shake: index < 4 ? "none" : "unclear" }),
    );
    const result = judgementOf(readings, (item) => item.shake, config.shakeShareMin, config);
    assert.equal(result.value, null);
    assert.match(result.reason ?? "", /only 4 of 10 frames are judged clearly/);
  });

  it("a frame the reader is not sure of cannot set a flag: its 'present' is not counted", () => {
    const readings = [
      reading(0, { shake: "present", confidence: 0.1 }),
      reading(500, { shake: "present", confidence: 0.1 }),
      reading(1000, { shake: "none" }),
      reading(1500, { shake: "none" }),
    ];
    // Two of four frames are judged (the share limit is met), and neither of them shows shake.
    const result = judgementOf(readings, (item) => item.shake, config.shakeShareMin, config);
    assert.deepEqual(result, { value: false, reason: null });
  });
});

describe("summariseFrameReadings and majority", () => {
  it("leaves every field null, with the reason, when the role gave no reading", () => {
    const summary = summariseFrameReadings({
      status: "refused",
      reason: "the reservation does not cover the call",
    });
    assert.equal(summary.captions, null);
    assert.equal(summary.shake, null);
    assert.equal(summary.speedRamps, null);
    assert.match(
      summary.reasons.captions ?? "",
      /^frame_reader gave no reading: the reservation does not cover the call$/,
    );
    assert.match(summary.reasons.motion ?? "", /^frame_reader gave no reading/);
  });

  it("names the motion reason of each judgement that is null", () => {
    const readings = Array.from({ length: 10 }, (_, index) =>
      reading(index * 500, { shake: "unclear", speedRamp: "none" }),
    );
    const summary = summariseFrameReadings({ status: "answered", readings });
    assert.equal(summary.shake, null);
    assert.equal(summary.speedRamps, false);
    assert.match(summary.reasons.motion ?? "", /^shake: only 0 of 10 frames are judged clearly/);
  });

  it("takes the majority, and is null on a tie", () => {
    assert.equal(majority(["a", "a", "b"]), "a");
    assert.equal(majority(["a", "b"]), null);
    assert.equal(majority([]), null);
  });
});
