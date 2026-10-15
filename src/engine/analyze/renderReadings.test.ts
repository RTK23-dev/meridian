// The render review's reads of the rendered frames (Bible 6.12, 12.3): overlay presence and caption and text word counts, from the
// frame_reader readings. Pure on hand-written readings, and the boxes are checked by their overlap. No text is read.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FrameReading } from "../claude/roles/frame_reader.ts";
import { analyzeConfig } from "./config.ts";
import type { TimedReading } from "./frameReader.ts";
import { boxIou, captionWordsAt, overlayMeasures, textWordsAt } from "./renderReadings.ts";

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

const CARD = { x: 0.05, y: 0.1, w: 0.4, h: 0.2 };

describe("boxIou: the overlap of two boxes in frame fractions", () => {
  it("is 1 for the same box, 0 for boxes that do not touch, and one third for a half overlap of equal boxes", () => {
    assert.equal(boxIou(CARD, CARD), 1);
    assert.equal(boxIou(CARD, { x: 0.6, y: 0.6, w: 0.2, h: 0.2 }), 0);
    // Two 0.4-wide boxes shifted by 0.2: intersection 0.2 x 0.2 = 0.04, union 0.08 + 0.08 - 0.04 = 0.12.
    const shifted = boxIou({ x: 0, y: 0, w: 0.4, h: 0.2 }, { x: 0.2, y: 0, w: 0.4, h: 0.2 });
    assert.ok(Math.abs(shifted - 0.04 / 0.12) < 1e-9, `iou ${shifted}`);
  });
});

describe("overlayMeasures: whether each graphic is drawn in its frame (Bible 12.3)", () => {
  it("is present when the frame shows an overlay on the clip's box, and absent when it shows one elsewhere", () => {
    const readings = [
      reading(1000, { overlays: [{ box: CARD, kind: "graphic" }] }),
      reading(2000, { overlays: [{ box: { x: 0.6, y: 0.6, w: 0.3, h: 0.2 }, kind: "graphic" }] }),
    ];
    const measures = overlayMeasures(
      [
        { clipId: "clip_card", atMs: 1000, box: CARD },
        { clipId: "clip_moved", atMs: 2000, box: CARD },
      ],
      readings,
    );
    assert.deepEqual(measures, [
      { clipId: "clip_card", present: true },
      { clipId: "clip_moved", present: false },
    ]);
  });

  it("with no box in the EDL, a frame with any overlay is present", () => {
    const readings = [reading(1000, { overlays: [{ box: CARD, kind: "sticker" }] }), reading(2000)];
    assert.deepEqual(
      overlayMeasures(
        [
          { clipId: "a", atMs: 1000 },
          { clipId: "b", atMs: 2000 },
        ],
        readings,
      ),
      [
        { clipId: "a", present: true },
        { clipId: "b", present: false },
      ],
    );
  });

  it("is null when the frame was not sent or the reader was not sure of it: a broken overlay is never read as present", () => {
    const readings = [
      reading(1000, { confidence: 0.1, overlays: [{ box: CARD, kind: "graphic" }] }),
    ];
    assert.deepEqual(
      overlayMeasures(
        [
          { clipId: "unsure", atMs: 1000, box: CARD },
          { clipId: "unsent", atMs: 3000, box: CARD },
        ],
        readings,
      ),
      [
        { clipId: "unsure", present: null },
        { clipId: "unsent", present: null },
      ],
    );
    assert.equal(config.overlayMinIou, 0.2);
  });
});

describe("captionWordsAt and textWordsAt: counts only", () => {
  it("counts the caption words of the frame at the time asked, and its text words outside the captions", () => {
    const readings = [
      reading(1000, {
        captions: [
          { box: CARD, words: 2, style: "plain", highlight: "none" },
          { box: CARD, words: 3, style: "plain", highlight: "none" },
        ],
        textWords: 4,
      }),
    ];
    assert.equal(captionWordsAt(readings, 1000), 5);
    assert.equal(textWordsAt(readings, 1000), 4);
  });

  it("is null for a frame that was not read, or read with too little confidence", () => {
    const readings = [
      reading(1000, {
        confidence: 0.2,
        captions: [{ box: CARD, words: 2, style: "plain", highlight: "none" }],
      }),
    ];
    assert.equal(captionWordsAt(readings, 1000), null);
    assert.equal(textWordsAt(readings, 1000), null);
    assert.equal(captionWordsAt(readings, 4000), null);
  });
});
