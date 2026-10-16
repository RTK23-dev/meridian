import assert from "node:assert/strict";
import { test } from "node:test";
import type { EditDecisionList, EdlClip, ShotSpec, Take, Word } from "../contracts/index.ts";
import { FIXTURE_IDS, videoDnaFixture } from "../contracts/fixtures/index.ts";
import {
  captionLengthInRange,
  captionsInSafeZone,
  captionsOffPresenterFace,
  captionTiming,
  captionWordsMatchVoice,
  checkEdl,
  cutsOutsideWords,
  drawableByCompiler,
  durationMatchesClock,
  edlMatchesContract,
  hookCaptionByMs,
  hookMotionWithinMs,
  layoutWithinTimeline,
  musicDuckedUnderSpeech,
  noBlackGaps,
  sameShotTypeRun,
  shotIdOf,
  shotLengthBounds,
  sourcesCoverClips,
  truePeakWithinLimit,
  voiceGainDrawable,
  voiceReachesMasterLoudness,
  type RuleContext,
} from "./rules.ts";
import { shotId } from "./test/inputs.ts";

type Track = EditDecisionList["tracks"][number];

function word(text: string, startMs: number, endMs: number): Word {
  return { wordId: `w_${text}_${startMs}`, text, startMs, endMs, confidence: 0.99 };
}

function visual(clipId: string, startMs: number, endMs: number, extra: Partial<EdlClip> = {}): EdlClip {
  return { clipId, startMs, endMs, srcUri: "store://takes/a.mp4", srcInMs: 0, ...extra };
}

function captionClip(captions: { startMs: number; endMs: number; words: Word[] }[], band: "upper" | "middle" | "lower" = "lower"): EdlClip {
  const end = captions[captions.length - 1]?.endMs ?? 0;
  return {
    clipId: "captions-1",
    startMs: 0,
    endMs: end,
    component: "captions.karaoke",
    props: {
      band,
      captions: captions.map((caption) => ({
        startMs: caption.startMs,
        endMs: caption.endMs,
        words: caption.words.map((item) => ({ text: item.text, startMs: item.startMs, endMs: item.endMs })),
      })),
    },
  };
}

function edlOf(options: {
  durationMs: number;
  tracks: Track[];
  effects?: EditDecisionList["effects"];
  gainDb?: number;
  music?: { duckDb: number };
}): EditDecisionList {
  return {
    schema: "meridian.edl/v1",
    edlId: FIXTURE_IDS.edl,
    requestId: FIXTURE_IDS.request,
    durationMs: options.durationMs,
    fps: 30,
    width: 1080,
    height: 1920,
    tracks: options.tracks,
    audio: {
      voice: { uri: "store://voice/x.wav", startMs: 0, endMs: options.durationMs, gainDb: options.gainDb ?? 1.2 },
      ...(options.music !== undefined
        ? { music: { uri: "store://music/m.wav", startMs: 0, endMs: options.durationMs, gainDb: -12, duckDb: options.music.duckDb } }
        : {}),
      sfx: [],
      masterLufs: -14,
    },
    effects: options.effects ?? [],
    seed: 7,
  };
}

function shotOf(n: number, visualType: ShotSpec["visualType"], layer: ShotSpec["layer"] = "base"): ShotSpec {
  return {
    shotId: shotId(n),
    beatId: `b${n}`,
    startMs: 0,
    endMs: 1000,
    visualType,
    layer,
    source: { kind: "stock", query: "q", minMs: 400 },
  };
}

const VOICE = { durationMs: 2000, lufs: -15.2 };

// --- contract ----------------------------------------------------------------------------------------------------------

test("an input that is not an EDL fails the contract check, and says why", () => {
  const result = edlMatchesContract({});
  assert.equal(result.pass, false);
  assert.ok(result.detail && result.detail.length > 0);
  assert.equal(edlMatchesContract(edlOf({ durationMs: 1000, tracks: [] })).pass, true);
});

// --- Bible 8.3: no cut inside a word -----------------------------------------------------------------------------------

test("no cut inside a word: a boundary between words passes, a boundary inside a word fails and names its shots", () => {
  const words = [word("a", 0, 500), word("b", 500, 1000)];
  const ctx: RuleContext = { words };
  const onTheWordEdge = edlOf({
    durationMs: 1000,
    tracks: [{ layer: "base", clips: [visual(shotId(1), 0, 500), visual(shotId(2), 500, 1000)] }],
  });
  assert.equal(cutsOutsideWords(onTheWordEdge, ctx).pass, true);

  const insideWord = edlOf({
    durationMs: 1000,
    tracks: [{ layer: "base", clips: [visual(shotId(1), 0, 400), visual(shotId(2), 400, 1000)] }],
  });
  const result = cutsOutsideWords(insideWord, ctx);
  assert.equal(result.pass, false);
  assert.equal(result.value, 1);
  assert.deepEqual(result.failingShotIds, [shotId(1), shotId(2)]);
  assert.equal(cutsOutsideWords(insideWord, {}).pass, false, "no voice words means the rule cannot run, so it fails");
});

// --- Bible 8.3: shot length --------------------------------------------------------------------------------------------

test("shot length: a shot under 0.4 s fails, and one over 6 s fails unless it is a presenter shot", () => {
  const ok = edlOf({ durationMs: 2000, tracks: [{ layer: "base", clips: [visual(shotId(1), 0, 1000), visual(shotId(2), 1000, 2000)] }] });
  assert.equal(shotLengthBounds(ok, {}).pass, true);

  const short = edlOf({ durationMs: 1000, tracks: [{ layer: "base", clips: [visual(shotId(1), 0, 300), visual(shotId(2), 300, 1000)] }] });
  const shortResult = shotLengthBounds(short, {});
  assert.equal(shortResult.pass, false);
  assert.deepEqual(shortResult.failingShotIds, [shotId(1)]);

  const long = edlOf({ durationMs: 6500, tracks: [{ layer: "base", clips: [visual(shotId(1), 0, 6500)] }] });
  assert.equal(shotLengthBounds(long, {}).pass, false, "6.5 s on a base shot is over the 6 s maximum");

  const presenterLayer = edlOf({ durationMs: 6500, tracks: [{ layer: "presenter", clips: [visual(shotId(1), 0, 6500)] }] });
  assert.equal(shotLengthBounds(presenterLayer, {}).pass, true, "presenter shots have no maximum");

  const presenterType = edlOf({ durationMs: 6500, tracks: [{ layer: "base", clips: [visual(shotId(1), 0, 6500)] }] });
  assert.equal(shotLengthBounds(presenterType, { shots: [shotOf(1, "ugc_presenter")] }).pass, true, "a ugc_presenter shot is exempt too");
});

// --- Bible 8.3: caption length, timing and the voice -------------------------------------------------------------------

test("caption length: every caption holds as many words as the grammar's range", () => {
  const words = [word("a", 0, 500), word("b", 500, 1000), word("c", 1000, 1500), word("d", 1500, 2000)];
  const grouped = edlOf({
    durationMs: 2000,
    tracks: [{ layer: "captions", clips: [captionClip([{ startMs: 0, endMs: 1000, words: words.slice(0, 2) }, { startMs: 1000, endMs: 2000, words: words.slice(2) }])] }],
  });
  assert.equal(captionLengthInRange(grouped, { grammar: videoDnaFixture.editGrammar }).pass, true, "two-word captions fit the 2-3 range");

  const four = edlOf({
    durationMs: 2000,
    tracks: [{ layer: "captions", clips: [captionClip([{ startMs: 0, endMs: 2000, words }])] }],
  });
  assert.equal(captionLengthInRange(four, { grammar: videoDnaFixture.editGrammar }).pass, false, "a four-word caption is over the range");
  assert.equal(captionLengthInRange(four, {}).pass, false, "no grammar means the rule cannot run");
});

test("caption words: the captions carry each voice word, in order, with its text and times", () => {
  const voice = [word("a", 0, 500), word("b", 500, 1000)];
  const matching = edlOf({ durationMs: 1000, tracks: [{ layer: "captions", clips: [captionClip([{ startMs: 0, endMs: 1000, words: voice }])] }] });
  assert.equal(captionWordsMatchVoice(matching, { words: voice }).pass, true);

  const dropped = edlOf({
    durationMs: 1000,
    tracks: [{ layer: "captions", clips: [captionClip([{ startMs: 0, endMs: 500, words: [voice[0] as Word] }])] }],
  });
  assert.equal(captionWordsMatchVoice(dropped, { words: voice }).pass, false, "a missing word fails");
  assert.equal(captionWordsMatchVoice(matching, {}).pass, false, "no voice words means the rule cannot run");
});

test("caption timing: a caption is on screen before its first word and off after its last", () => {
  const words = [word("a", 500, 1000)];
  const onTime = edlOf({ durationMs: 1000, tracks: [{ layer: "captions", clips: [captionClip([{ startMs: 500, endMs: 1000, words }])] }] });
  assert.equal(captionTiming(onTime).pass, true);
  const late = edlOf({ durationMs: 1000, tracks: [{ layer: "captions", clips: [captionClip([{ startMs: 600, endMs: 1000, words }])] }] });
  assert.equal(captionTiming(late).pass, false, "on screen 100 ms after the word starts");
  const early = edlOf({ durationMs: 1000, tracks: [{ layer: "captions", clips: [captionClip([{ startMs: 500, endMs: 900, words }])] }] });
  assert.equal(captionTiming(early).pass, false, "off before the word ends");
  assert.equal(captionTiming(edlOf({ durationMs: 1000, tracks: [] })).pass, false, "no captions fails");
});

// --- Bible 8.3: safe zones and the face -------------------------------------------------------------------------------

test("safe zones: a graphic box in the top margin fails and names its shot", () => {
  const captions = edlOf({ durationMs: 1000, tracks: [{ layer: "captions", clips: [captionClip([{ startMs: 0, endMs: 1000, words: [word("a", 0, 1000)] }], "upper")] }] });
  assert.equal(captionsInSafeZone(captions).pass, true, "the upper band is inside the zones");
  const boxed = edlOf({
    durationMs: 1000,
    tracks: [
      { layer: "captions", clips: [captionClip([{ startMs: 0, endMs: 1000, words: [word("a", 0, 1000)] }])] },
      { layer: "graphics", clips: [visual(shotId(3), 0, 1000, { component: "cta.card", props: {}, box: { x: 0, y: 0, w: 300, h: 100 } })] },
    ],
  });
  const result = captionsInSafeZone(boxed);
  assert.equal(result.pass, false);
  assert.deepEqual(result.failingShotIds, [shotId(3)]);
});

test("the face: a caption over a presenter's assumed face area fails; the lower band passes", () => {
  const presenter: Track = { layer: "presenter", clips: [visual(shotId(1), 0, 2000)] };
  const upper = edlOf({ durationMs: 2000, tracks: [presenter, { layer: "captions", clips: [captionClip([{ startMs: 0, endMs: 1000, words: [word("a", 0, 1000)] }], "upper")] }] });
  assert.equal(captionsOffPresenterFace(upper).pass, false);
  const lower = edlOf({ durationMs: 2000, tracks: [presenter, { layer: "captions", clips: [captionClip([{ startMs: 0, endMs: 1000, words: [word("a", 0, 1000)] }], "lower")] }] });
  assert.equal(captionsOffPresenterFace(lower).pass, true);
  const boxedFar = edlOf({
    durationMs: 2000,
    tracks: [
      { layer: "presenter", clips: [visual(shotId(1), 0, 2000, { box: { x: 0, y: 1500, w: 1080, h: 400 } })] },
      { layer: "captions", clips: [captionClip([{ startMs: 0, endMs: 1000, words: [word("a", 0, 1000)] }], "upper")] },
    ],
  });
  assert.equal(captionsOffPresenterFace(boxedFar).pass, true, "a presenter box at the bottom leaves the upper band clear");
});

// --- Bible 8.3: loudness ----------------------------------------------------------------------------------------------

test("loudness: the voice lands on -14 LUFS from its measured level; a gain above +12 dB is not drawable", () => {
  const onTarget = edlOf({ durationMs: 2000, tracks: [], gainDb: 1.2 });
  assert.equal(voiceReachesMasterLoudness(onTarget, { voice: VOICE }).pass, true);
  const off = edlOf({ durationMs: 2000, tracks: [], gainDb: 3 });
  assert.equal(voiceReachesMasterLoudness(off, { voice: VOICE }).pass, false, "lands at -12.2 LUFS");
  assert.equal(voiceReachesMasterLoudness(onTarget, {}).pass, false, "no measured loudness means the rule cannot run");

  assert.equal(voiceGainDrawable(onTarget).pass, true);
  assert.equal(voiceGainDrawable(edlOf({ durationMs: 2000, tracks: [], gainDb: 13 })).pass, false);
});

test("music is ducked by 18 dB under speech; with no music the rule passes and says so", () => {
  assert.equal(musicDuckedUnderSpeech(edlOf({ durationMs: 1000, tracks: [] })).pass, true);
  assert.match(musicDuckedUnderSpeech(edlOf({ durationMs: 1000, tracks: [] })).detail ?? "", /no music/);
  assert.equal(musicDuckedUnderSpeech(edlOf({ durationMs: 1000, tracks: [], music: { duckDb: -18 } })).pass, true);
  assert.equal(musicDuckedUnderSpeech(edlOf({ durationMs: 1000, tracks: [], music: { duckDb: -12 } })).pass, false);
});

test("the true peak is at most -1 dBTP, and an unmeasured peak fails", () => {
  assert.equal(truePeakWithinLimit(-1.5).pass, true);
  assert.equal(truePeakWithinLimit(-0.4).pass, false);
  assert.equal(truePeakWithinLimit(undefined).pass, false);
});

// --- the clock and the picture ----------------------------------------------------------------------------------------

test("the timeline is the voice plus the outro, with the voice placed from 0", () => {
  const edl = edlOf({ durationMs: 2000, tracks: [] });
  assert.equal(durationMatchesClock(edl, { voice: VOICE, outroMs: 0 }).pass, true);
  assert.equal(durationMatchesClock(edl, { voice: VOICE, outroMs: 500 }).pass, false, "the outro is missing");
  assert.equal(durationMatchesClock(edl, {}).pass, false, "no voice means the rule cannot run");
});

test("black frames: no gap in the picture longer than one frame (33.3 ms), at the start, between or at the end", () => {
  const oneFrame = edlOf({
    durationMs: 2000,
    tracks: [{ layer: "base", clips: [visual(shotId(1), 0, 1000), visual(shotId(2), 1033, 2000)] }],
  });
  assert.equal(noBlackGaps(oneFrame, {}).pass, true, "a 33 ms gap is one frame");
  const twoFrames = edlOf({
    durationMs: 2000,
    tracks: [{ layer: "base", clips: [visual(shotId(1), 0, 1000), visual(shotId(2), 1034, 2000)] }],
  });
  assert.equal(noBlackGaps(twoFrames, {}).pass, false, "34 ms is over one frame");
  const trailing = edlOf({ durationMs: 1100, tracks: [{ layer: "base", clips: [visual(shotId(1), 0, 1000)] }] });
  assert.equal(noBlackGaps(trailing, {}).pass, false, "the last 100 ms show nothing");
});

test("same shot type: no more than 3 shots of one type in a row, presenter beats exempt, split parts counted once", () => {
  const four = [1, 2, 3, 4];
  const shotsCoded = four.map((n) => shotOf(n, "coded_graphics"));
  const run = edlOf({
    durationMs: 4000,
    tracks: [{ layer: "base", clips: four.map((n, index) => visual(shotId(n), index * 1000, index * 1000 + 1000)) }],
  });
  const failing = sameShotTypeRun(run, { shots: shotsCoded });
  assert.equal(failing.pass, false);
  assert.deepEqual(failing.failingShotIds, four.map((n) => shotId(n)));

  const three = edlOf({
    durationMs: 3000,
    tracks: [{ layer: "base", clips: [1, 2, 3].map((n, index) => visual(shotId(n), index * 1000, index * 1000 + 1000)) }],
  });
  assert.equal(sameShotTypeRun(three, { shots: shotsCoded }).pass, true);

  const presenters = [1, 2, 3, 4, 5].map((n) => shotOf(n, "ugc_presenter"));
  const presenterRun = edlOf({
    durationMs: 5000,
    tracks: [{ layer: "base", clips: [1, 2, 3, 4, 5].map((n, index) => visual(shotId(n), index * 1000, index * 1000 + 1000)) }],
  });
  assert.equal(sameShotTypeRun(presenterRun, { shots: presenters }).pass, true, "ugc_presenter beats are exempt");

  const split = edlOf({
    durationMs: 3000,
    tracks: [
      {
        layer: "base",
        clips: [visual(shotId(1), 0, 500), visual(`${shotId(1)}-p1`, 500, 1000), visual(shotId(2), 1000, 2000), visual(shotId(3), 2000, 3000)],
      },
    ],
  });
  assert.equal(shotIdOf(`${shotId(1)}-p1`), shotId(1), "a split part belongs to its shot");
  assert.equal(sameShotTypeRun(split, { shots: shotsCoded }).pass, true, "two parts of shot 1 and one each of 2 and 3 are three shots");

  assert.equal(sameShotTypeRun(run, {}).pass, false, "no plan shots means the rule cannot run");
  const unknown = edlOf({ durationMs: 1000, tracks: [{ layer: "base", clips: [visual(shotId(9), 0, 1000)] }] });
  assert.equal(sameShotTypeRun(unknown, { shots: shotsCoded }).pass, false, "a clip that belongs to no shot fails");
});

// --- the hook -----------------------------------------------------------------------------------------------------------

test("the hook: the caption is on screen by 500 ms, and motion starts within 300 ms", () => {
  const words = [word("a", 0, 500)];
  const early = edlOf({ durationMs: 1000, tracks: [{ layer: "captions", clips: [captionClip([{ startMs: 0, endMs: 500, words }])] }] });
  assert.equal(hookCaptionByMs(early).pass, true);
  const late = edlOf({ durationMs: 1000, tracks: [{ layer: "captions", clips: [captionClip([{ startMs: 600, endMs: 1000, words }])] }] });
  assert.equal(hookCaptionByMs(late).pass, false);
  assert.equal(hookCaptionByMs(edlOf({ durationMs: 1000, tracks: [] })).pass, false);

  const punch = edlOf({ durationMs: 1000, tracks: [], effects: [{ atMs: 0, kind: "punch_in", params: { scale: 1.05 } }] });
  assert.equal(hookMotionWithinMs(punch, {}).pass, true);
  const cut = edlOf({ durationMs: 1000, tracks: [{ layer: "base", clips: [visual(shotId(1), 0, 200), visual(shotId(2), 200, 1000)] }] });
  assert.equal(hookMotionWithinMs(cut, {}).pass, true, "a cut at 200 ms is motion that starts in time");
  const still = edlOf({ durationMs: 1000, tracks: [{ layer: "base", clips: [visual(shotId(1), 0, 1000)] }] });
  assert.equal(hookMotionWithinMs(still, {}).pass, false, "no motion effect and no cut before 300 ms");
});

// --- sources and the compiler -----------------------------------------------------------------------------------------

test("sources: a clip never shows more of its take than the take holds", () => {
  const take = (durationMs: number): Take => ({
    schema: "meridian.take/v1",
    takeId: FIXTURE_IDS.take1,
    shotId: shotId(1),
    attempt: 1,
    provider: "fixture",
    model: "m",
    uri: "store://takes/a.mp4",
    durationMs,
    width: 1080,
    height: 1920,
    promptHash: "sha256:" + "0".repeat(64),
    costUsd: 0,
    latencyMs: 1,
  });
  const edl = edlOf({ durationMs: 2000, tracks: [{ layer: "base", clips: [visual(shotId(1), 0, 2000)] }] });
  assert.equal(sourcesCoverClips(edl, { takes: [take(2000)] }).pass, true);
  const short = sourcesCoverClips(edl, { takes: [take(1500)] });
  assert.equal(short.pass, false);
  assert.deepEqual(short.failingShotIds, [shotId(1)]);
  assert.equal(sourcesCoverClips(edl, { takes: [] }).pass, false, "no take for the uri fails");
  assert.equal(sourcesCoverClips(edl, {}).pass, false, "no takes means the rule cannot run");

  const part = edlOf({
    durationMs: 2000,
    tracks: [{ layer: "base", clips: [visual(shotId(1), 0, 1000, { srcInMs: 0 }), visual(`${shotId(1)}-p1`, 1000, 2000, { srcInMs: 1000 })] }],
  });
  assert.equal(sourcesCoverClips(part, { takes: [take(2000)] }).pass, true, "the second part needs 1000 + 1000 ms of a 2000 ms take");
});

test("clips on one track never overlap, and clips and effects fit the timeline", () => {
  const overlap = edlOf({ durationMs: 2000, tracks: [{ layer: "base", clips: [visual(shotId(1), 0, 1200), visual(shotId(2), 1000, 2000)] }] });
  assert.equal(layoutWithinTimeline(overlap).pass, false);
  const past = edlOf({ durationMs: 2000, tracks: [{ layer: "base", clips: [visual(shotId(1), 0, 2100)] }] });
  assert.equal(layoutWithinTimeline(past).pass, false);
  const effectPast = edlOf({ durationMs: 2000, tracks: [], effects: [{ atMs: 2500, kind: "flash", params: {} }] });
  assert.equal(layoutWithinTimeline(effectPast).pass, false);
  const fine = edlOf({ durationMs: 2000, tracks: [{ layer: "base", clips: [visual(shotId(1), 0, 1000), visual(shotId(2), 1000, 2000)] }] });
  assert.equal(layoutWithinTimeline(fine).pass, true);
});

test("the compiler draws only hard, fade and whip transitions, and punch-ins between 1 and 1.5", () => {
  const zoomTransition = edlOf({
    durationMs: 2000,
    tracks: [{ layer: "base", clips: [visual(shotId(1), 0, 1000), visual(shotId(2), 1000, 2000, { transitionIn: "zoom" })] }],
  });
  assert.equal(drawableByCompiler(zoomTransition).pass, false);
  const ramp = edlOf({ durationMs: 1000, tracks: [], effects: [{ atMs: 0, kind: "speed_ramp", params: {} }] });
  assert.equal(drawableByCompiler(ramp).pass, false, "speed_ramp is refused by the compiler");
  const big = edlOf({ durationMs: 1000, tracks: [], effects: [{ atMs: 0, kind: "punch_in", params: { scale: 1.6 } }] });
  assert.equal(drawableByCompiler(big).pass, false);
  const fine = edlOf({
    durationMs: 1000,
    tracks: [{ layer: "base", clips: [visual(shotId(1), 0, 500), visual(shotId(2), 500, 1000, { transitionIn: "whip" })] }],
    effects: [
      { atMs: 0, kind: "punch_in", params: { scale: 1.1 } },
      { atMs: 500, kind: "flash", params: { opacity: 0.5 } },
    ],
  });
  assert.equal(drawableByCompiler(fine).pass, true);
});

// --- the whole check -------------------------------------------------------------------------------------------------

test("checkEdl stops at the contract, and otherwise names every failing shot once", () => {
  const broken = checkEdl({ schema: "nope" }, {});
  assert.equal(broken.pass, false);
  assert.equal(broken.checks.length, 1, "only the contract check runs on an input that does not parse");

  const edl = edlOf({
    durationMs: 1000,
    tracks: [{ layer: "base", clips: [visual(shotId(1), 0, 300), visual(shotId(2), 300, 1000)] }],
  });
  const verdict = checkEdl(edl, { words: [], shots: [shotOf(1, "stock_footage"), shotOf(2, "stock_footage")], takes: [] });
  assert.equal(verdict.pass, false);
  assert.ok(verdict.failingShotIds.includes(shotId(1)));
  assert.equal(new Set(verdict.failingShotIds).size, verdict.failingShotIds.length, "each shot is named once");
  assert.ok(verdict.checks.length > 10, "every rule ran");
});
