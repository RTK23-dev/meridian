import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ScriptBeat } from "../contracts/request.ts";
import { buildVoiceText, scriptTokens } from "./text.ts";
import { beatSpansOf } from "./timings.ts";
import { alignTokens } from "./align.ts";
import type { Word } from "../contracts/analysis.ts";

const beats: ScriptBeat[] = [
  {
    beatId: "b1",
    role: "hook",
    text: "  Stop scrolling: this blender crushes ice in seconds. ",
    emphasis: ["scrolling", "seconds"],
  },
  { beatId: "b2", role: "proof", text: "It costs 29 dollars", emphasis: ["29"] },
  { beatId: "b3", role: "cta", text: "Tap the link now!" },
];

describe("the narration text and its pacing marks (Bible 6.3 step 1)", () => {
  it("joins the beats in order, trims them, and closes a beat that has no sentence stop", () => {
    const { text, marks } = buildVoiceText(beats);
    assert.equal(
      text,
      "Stop scrolling: this blender crushes ice in seconds. It costs 29 dollars. Tap the link now!",
    );
    assert.deepEqual(
      marks.map((mark) => mark.beatId),
      ["b1", "b2", "b3"],
    );
    assert.equal(text.slice(marks[1]?.startChar, marks[1]?.endChar), "It costs 29 dollars.");
  });

  it("places each emphasis word at its offsets in the text, as a whole word", () => {
    const { text, marks } = buildVoiceText(beats);
    const first = marks[0]?.emphasis ?? [];
    assert.deepEqual(
      first.map((mark) => text.slice(mark.startChar, mark.endChar)),
      ["scrolling", "seconds"],
    );
    const second = marks[1]?.emphasis ?? [];
    assert.equal(text.slice(second[0]?.startChar, second[0]?.endChar), "29");
  });

  it("does not mark a word that only contains the emphasis", () => {
    const { marks } = buildVoiceText([
      { beatId: "b1", role: "hook", text: "Scrolling is over.", emphasis: ["roll"] },
    ]);
    assert.deepEqual(marks[0]?.emphasis, []);
  });

  it("counts the script's word tokens per beat, for the alignment", () => {
    const counted = scriptTokens(beats);
    assert.deepEqual(counted.perBeat, [8, 4, 4]);
    assert.equal(counted.tokens.length, 16);
  });
});

describe("the beat spans of a take (Bible 6.3: the spans cover the duration without gaps)", () => {
  const heard: Word[] = [
    { wordId: "w0001", text: "Stop", startMs: 0, endMs: 200, confidence: 0.9 },
    { wordId: "w0002", text: "scrolling", startMs: 250, endMs: 600, confidence: 0.9 },
    { wordId: "w0003", text: "it", startMs: 900, endMs: 1000, confidence: 0.9 },
    { wordId: "w0004", text: "costs", startMs: 1050, endMs: 1300, confidence: 0.9 },
    { wordId: "w0005", text: "Tap", startMs: 1800, endMs: 1900, confidence: 0.9 },
  ];
  const script = ["stop", "scrolling", "it", "costs", "tap"];
  const heardTokens = heard.map((_, index) => index);

  it("starts the first beat at zero, starts each later beat at its first word, and ends the last at the duration", () => {
    const alignment = alignTokens(
      script,
      heard.map((word) => word.text.toLowerCase()),
    );
    const { spans, problems } = beatSpansOf({
      beatIds: ["b1", "b2", "b3"],
      tokenCounts: [2, 2, 1],
      alignment,
      heardTokenWord: heardTokens,
      words: heard,
      durationMs: 2000,
    });
    assert.deepEqual(problems, []);
    assert.deepEqual(spans, [
      { beatId: "b1", startMs: 0, endMs: 900 },
      { beatId: "b2", startMs: 900, endMs: 1800 },
      { beatId: "b3", startMs: 1800, endMs: 2000 },
    ]);
  });

  it("reports a beat whose first word was not said, rather than placing it", () => {
    const alignment = alignTokens(
      ["stop", "scrolling", "it", "costs"],
      ["stop", "scrolling", "costs"],
    );
    const { spans, problems } = beatSpansOf({
      beatIds: ["b1", "b2"],
      tokenCounts: [2, 2],
      alignment,
      heardTokenWord: [0, 1, 2],
      words: heard.slice(0, 3),
      durationMs: 1500,
    });
    assert.ok(problems.some((problem) => /first word of beat b2 was not said/.test(problem)));
    assert.equal(
      spans.some((span) => span.beatId === "b2"),
      false,
      "the beat with no start is not placed",
    );
  });

  it("reports a beat with no words", () => {
    const { problems } = beatSpansOf({
      beatIds: ["b1", "b2"],
      tokenCounts: [2, 0],
      alignment: alignTokens(["a", "b"], ["a", "b"]),
      heardTokenWord: [0, 1],
      words: heard.slice(0, 2),
      durationMs: 1000,
    });
    assert.ok(problems.some((problem) => /beat b2 has no spoken words/.test(problem)));
  });
});
