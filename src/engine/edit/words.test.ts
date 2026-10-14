import assert from "node:assert/strict";
import { test } from "node:test";
import type { BeatSpan, Word } from "../contracts/index.ts";
import { roundToFrame, shotTargetMs } from "./time.ts";
import { beatIndexOf, captionBreaks, emphasisStarts, gapMidpoints, groupWords, insideWord, snapCut } from "./words.ts";

function word(text: string, startMs: number, endMs: number): Word {
  return { wordId: `w_${text}_${startMs}`, text, startMs, endMs, confidence: 0.99 };
}

const CONTIGUOUS: Word[] = [word("a", 0, 500), word("b", 500, 1000), word("c", 1000, 1500)];
const WITH_GAP: Word[] = [word("a", 0, 500), word("b", 600, 1000)];

test("a time is inside a word only strictly between its start and end", () => {
  assert.equal(insideWord(CONTIGUOUS, 0), false);
  assert.equal(insideWord(CONTIGUOUS, 250), true);
  assert.equal(insideWord(CONTIGUOUS, 500), false, "a word edge is a legal cut");
});

test("a gap is a pause of at least 80 ms between two words, and the cut sits at its midpoint", () => {
  assert.deepEqual(gapMidpoints(WITH_GAP), [550]);
  assert.deepEqual(gapMidpoints([word("a", 0, 500), word("b", 540, 1000)]), [], "a 40 ms gap is too short");
});

test("a cut snaps to a word gap within 250 ms, then onto the frame grid inside that gap", () => {
  assert.equal(snapCut(520, { lo: 0, hi: 1000 }, { words: WITH_GAP }), roundToFrame(550), "the gap midpoint 550, framed");
  assert.equal(snapCut(100, { lo: 0, hi: 1000 }, { words: WITH_GAP }), 0, "the gap 550 is out of reach, so 100 (inside word a) goes to its edge 0");
});

test("a cut inside a word with no gap moves to the nearest word edge", () => {
  assert.equal(snapCut(300, { lo: 0, hi: 1000 }, { words: CONTIGUOUS }), 500, "300 is 200 from the edge 500 and 300 from 0");
  assert.equal(snapCut(200, { lo: 0, hi: 1000 }, { words: CONTIGUOUS }), 0);
});

test("a cut outside every word and gap stays on the nearest frame", () => {
  assert.equal(snapCut(1000, { lo: 0, hi: 2000 }, { words: [] }), 1000);
  assert.equal(snapCut(510, { lo: 0, hi: 2000 }, { words: [] }), roundToFrame(510));
});

test("a cut is always inside its range", () => {
  assert.equal(snapCut(2000, { lo: 0, hi: 1500 }, { words: [] }), 1500);
  assert.equal(snapCut(-40, { lo: 10, hi: 1500 }, { words: [] }), 10);
});

test("with music, a cut moves to the nearest beat within 120 ms unless the beat is inside a word", () => {
  assert.equal(snapCut(620, { lo: 0, hi: 2000 }, { words: CONTIGUOUS, beatPeriodMs: 500 }), 500, "620 sits in word b; its edge 500 is on the beat");
  const longWord = [word("a", 0, 400), word("b", 400, 1200)];
  assert.equal(snapCut(420, { lo: 0, hi: 2000 }, { words: longWord, beatPeriodMs: 500 }), 400, "the beat 500 is inside word b, so the edge 400 stays");
  const edgeFar = [word("a", 0, 700), word("b", 700, 1400)];
  assert.equal(snapCut(690, { lo: 0, hi: 2000 }, { words: edgeFar, beatPeriodMs: 500 }), 700, "the beat 500 is 200 from 700, outside 120 ms");
});

test("the beat a time falls in, or -1 when none does", () => {
  const beats: BeatSpan[] = [
    { beatId: "b1", startMs: 0, endMs: 1000 },
    { beatId: "b2", startMs: 1000, endMs: 2000 },
  ];
  assert.equal(beatIndexOf(beats, 0), 0);
  assert.equal(beatIndexOf(beats, 1000), 1, "the end of a beat is the next beat's start");
  assert.equal(beatIndexOf(beats, 2000), -1);
});

test("a caption may end after punctuation, at a beat change, and always at the end of the video", () => {
  const beats: BeatSpan[] = [
    { beatId: "b1", startMs: 0, endMs: 1500 },
    { beatId: "b2", startMs: 1500, endMs: 3000 },
  ];
  const words = [word("Stop.", 0, 500), word("now", 500, 1000), word("and", 1000, 1500), word("go", 1500, 2000), word("fast", 2000, 2500), word("please", 2500, 3000)];
  assert.deepEqual(captionBreaks(words, beats), [true, false, true, false, false, true]);
});

test("groupWords ends captions on breaks when the size range allows, and keeps every caption in range", () => {
  const breaks = [false, false, true, false, false, true];
  assert.deepEqual(groupWords(breaks, { min: 2, max: 3 }), [
    [0, 3],
    [3, 6],
  ]);
  const all = Array.from({ length: 7 }, () => true);
  const groups = groupWords(all, { min: 2, max: 3 });
  assert.ok(groups !== null);
  assert.equal(groups.reduce((sum, [start, end]) => sum + (end - start), 0), 7);
  assert.ok(groups.every(([start, end]) => end - start >= 2 && end - start <= 3));
  assert.deepEqual(groupWords(all, { min: 2, max: 3 }), groups, "the same input gives the same grouping");
});

test("groupWords refuses a split that cannot fit the range", () => {
  assert.equal(groupWords([false, false, false, false, true], { min: 2, max: 2 }), null, "five words cannot be pairs");
  assert.equal(groupWords([true], { min: 2, max: 3 }), null, "one word is under the minimum");
  assert.deepEqual(groupWords([], { min: 2, max: 3 }), []);
});

test("emphasis marks match the words of their own beat, ignoring case and punctuation", () => {
  const beats: BeatSpan[] = [
    { beatId: "b1", startMs: 0, endMs: 1000 },
    { beatId: "b2", startMs: 1000, endMs: 2000 },
  ];
  const words = [word("Lying!", 200, 400), word("truth", 1100, 1300), word("lying", 1400, 1600)];
  assert.deepEqual(emphasisStarts(words, beats, [{ beatId: "b1", term: "lying" }]), [200], "the b2 'lying' is not in b1");
  assert.deepEqual(emphasisStarts(words, beats, [{ beatId: "b2", term: "truth lying" }]), [1100, 1400]);
  assert.deepEqual(emphasisStarts(words, beats, [{ beatId: "b1", term: "   " }]), [], "an empty term matches nothing");
});

test("the shot-length target reads the curve at the shot's tenth of the video, with a floor of 1 ms", () => {
  const curve = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 0];
  assert.equal(shotTargetMs(curve, 500, 10000), 1000);
  assert.equal(shotTargetMs(curve, 2500, 10000), 3000);
  assert.equal(shotTargetMs(curve, 9900, 10000), 1, "a zero value cannot be a target, so the floor is 1 ms");
});
