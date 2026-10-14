import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { editGrammarSchema } from "../contracts/analysis.ts";
import {
  computeEditGrammar,
  hookPayoffOf,
  type GrammarInput,
  type MeasuredZoom,
} from "./grammar.ts";

// A 6.0 s reference with shots of 1.5 s, cut at 1500, 3000 and 4500 ms by hand. The shot-length labels below are those cut
// times, so the grammar is checked against hand labels, not against its own output.
const TALKING = "talking_head" as const;
const flatBrightness = (value: number) =>
  Array.from({ length: 12 }, (_, index) => ({ atMs: index * 500, value }));
const flatMotion = Array.from({ length: 12 }, (_, index) => ({ atMs: index * 500, value: 0 }));
const flatLoudness = Array.from({ length: 60 }, (_, index) => ({ atMs: index * 100, lufs: -16 }));
const SOUND = {
  hitsMs: [],
  soundEffectHitsMs: [],
  musicShare: 0,
  music: false,
  bpm: 120,
  sfxPer10s: 0,
  silenceBeforePayoffMs: null,
};
const NO_ZOOM: MeasuredZoom = { jumps: [], shake: false, speedRamps: false };
const CAPTIONS = {
  wordsPerCaption: [2, 3] as [number, number],
  position: "lower" as const,
  style: "bold sans",
  highlightCurrentWord: true,
};

function complete(overrides: Partial<GrammarInput> = {}): GrammarInput {
  return {
    durationMs: 6000,
    cutsMs: [1500, 3000, 4500],
    segments: [
      { startMs: 0, endMs: 1500, shotType: TALKING },
      { startMs: 1500, endMs: 3000, shotType: TALKING },
      { startMs: 3000, endMs: 4500, shotType: TALKING, beatRole: "payoff" },
      { startMs: 4500, endMs: 6000, shotType: TALKING },
    ],
    sound: SOUND,
    loudness: flatLoudness,
    brightness: flatBrightness(0.5),
    motion: flatMotion,
    captions: CAPTIONS,
    zoom: NO_ZOOM,
    loop: false,
    ...overrides,
  };
}

describe("the edit grammar of a reference (Bible 8.1)", () => {
  it("computes every field from the measurements, and the result parses as an EditGrammar", () => {
    const result = computeEditGrammar(complete());
    assert.deepEqual(result.unknown, []);
    assert.ok(result.grammar);
    assert.equal(editGrammarSchema.safeParse(result.grammar).success, true);
  });

  it("matches the hand labels: the first cut at 1500 ms, and shots of 1500 ms", () => {
    const grammar = computeEditGrammar(complete()).grammar;
    assert.equal(grammar?.hookFirstCutMs, 1500);
    assert.equal(grammar?.shotLengthMs.p25, 1500);
    assert.equal(grammar?.shotLengthMs.p50, 1500);
    assert.equal(grammar?.shotLengthMs.p75, 1500);
    assert.deepEqual(
      grammar?.shotLengthMs.curve,
      Array.from({ length: 10 }, () => 1500),
    );
  });

  it("takes the payoff segment as hookPayoffMs, and the second cut when there is no payoff or item", () => {
    assert.equal(computeEditGrammar(complete()).grammar?.hookPayoffMs, 3000);
    const noPayoff = complete({
      segments: complete().segments.map((segment) => ({ ...segment, beatRole: undefined })),
    });
    assert.equal(computeEditGrammar(noPayoff).grammar?.hookPayoffMs, 3000);
    assert.equal(hookPayoffOf([], [1000, 2500], 6000), 2500);
    assert.equal(hookPayoffOf([], [], 6000), 6000);
  });

  it("measures the rehook interval from shot-type changes and sound hits, as the median gap", () => {
    const segments = [
      { startMs: 0, endMs: 1500, shotType: TALKING },
      { startMs: 1500, endMs: 3000, shotType: "product_closeup" as const },
      { startMs: 3000, endMs: 4500, shotType: TALKING },
      { startMs: 4500, endMs: 6000, shotType: TALKING },
    ];
    // Interrupts: the cuts at 1500 and 3000 change the shot type; a sound hit at 2250. Gaps: 1500, 750, 750, 3000. Median 1125.
    const result = computeEditGrammar(complete({ segments, sound: { ...SOUND, hitsMs: [2250] } }));
    assert.equal(result.grammar?.rehookIntervalMs, 1125);
  });

  it("reads the transitions of each cut: a flash, a whip and a zoom", () => {
    const brightness = [0.8, 0.8, 0.8, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2].map(
      (value, index) => ({ atMs: index * 500, value }),
    );
    const motion = flatMotion.map((sample) =>
      sample.atMs === 3000 ? { ...sample, value: 0.5 } : sample,
    );
    const zoom: MeasuredZoom = {
      jumps: [{ atMs: 4520, scale: 1.2 }],
      shake: false,
      speedRamps: false,
    };
    const grammar = computeEditGrammar(complete({ brightness, motion, zoom })).grammar;
    assert.deepEqual(
      grammar?.transitions.map((item) => item.kind),
      ["flash", "whip", "zoom"],
    );
    for (const item of grammar?.transitions ?? []) assert.ok(Math.abs(item.share - 1 / 3) < 1e-9);
  });

  it("reports the zoom and motion fields from the zoom reading (jumps per 10 s and their median scale)", () => {
    const zoom: MeasuredZoom = {
      jumps: [
        { atMs: 1000, scale: 1.2 },
        { atMs: 4000, scale: 1.1 },
      ],
      shake: true,
      speedRamps: false,
    };
    const grammar = computeEditGrammar(complete({ zoom })).grammar;
    assert.equal(grammar?.motion.punchInsPer10s, 2 / 0.6);
    assert.equal(grammar?.motion.punchInScale, 1.15);
    assert.equal(grammar?.motion.shakeOnImpact, true);
  });

  it("refuses to return a grammar when a reading is missing, and says which", () => {
    const result = computeEditGrammar(
      complete({ captions: null, zoom: null, loop: null, sound: null, loudness: [] }),
    );
    assert.equal(result.grammar, null);
    const text = result.unknown.join("\n");
    assert.match(text, /captions/);
    assert.match(text, /zoom/);
    assert.match(text, /loop/);
    assert.match(text, /sound/);
  });

  it("gives the sound energy as ten finite tenths, with silence read as the gate", () => {
    const quiet = complete({ loudness: flatLoudness.map((sample) => ({ ...sample, lufs: null })) });
    const grammar = computeEditGrammar(quiet).grammar;
    assert.deepEqual(
      grammar?.sound.energyCurve,
      Array.from({ length: 10 }, () => -70),
    );
  });
});
