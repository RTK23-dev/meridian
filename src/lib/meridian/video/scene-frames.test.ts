import assert from "node:assert/strict";
import test from "node:test";
import { SCENE_FRAME_SPANS, selectSceneSpanFrames, type TimelineScene } from "./scene-frames.ts";

const scene = (id: string, startMs: number, endMs: number, relevance: number | null, keyframeRef?: string): TimelineScene => ({
  id,
  startMs,
  endMs,
  relevance,
  ...(keyframeRef ? { keyframeRef } : {}),
});

// Eight 1-second scenes across an 8-second video: two per quarter (0-2s, 2-4s, 4-6s, 6-8s).
const EIGHT: TimelineScene[] = [
  scene("s0", 0, 1000, 0.2),
  scene("s1", 1000, 2000, 0.7),
  scene("s2", 2000, 3000, 0.4),
  scene("s3", 3000, 4000, 0.9),
  scene("s4", 4000, 5000, 0.5),
  scene("s5", 5000, 6000, 0.1),
  scene("s6", 6000, 7000, 0.3),
  scene("s7", 7000, 8000, 0.8),
];

test("no timeline, or an empty one: nothing is selected, and the count is zero", () => {
  for (const timeline of [undefined, null, []] as const) {
    const selection = selectSceneSpanFrames(timeline);
    assert.equal(selection.status, "no_timeline");
    assert.equal(selection.sceneCount, 0);
    assert.deepEqual(selection.frames, []);
    assert.match(selection.summary, /No scene timeline was supplied/);
  }
});

test("a timeline whose scenes all have unusable timestamps is no timeline, and says why each scene was dropped", () => {
  const selection = selectSceneSpanFrames([
    scene("bad-end", 2000, 2000, 0.9),
    scene("bad-start", -5, 1000, 0.9),
    { id: "nan", startMs: Number.NaN, endMs: 1000, relevance: 0.9 },
  ]);
  assert.equal(selection.status, "no_timeline");
  assert.equal(selection.sceneCount, 0);
  assert.deepEqual(selection.omitted.map((entry) => entry.reason), ["invalid_timestamps", "invalid_timestamps", "invalid_timestamps"]);
  assert.deepEqual(selection.frames, []);
});

test("fewer than four scenes: the scenes that exist are returned in time order, with their count, and nothing is added", () => {
  const selection = selectSceneSpanFrames([scene("late", 4000, 6000, null), scene("early", 0, 2000, 0.6), scene("bad", 9000, 8000, 0.9)]);
  assert.equal(selection.status, "fewer_than_four_scenes");
  assert.equal(selection.sceneCount, 2);
  assert.deepEqual(selection.frames.map((frame) => frame.sceneId), ["early", "late"]);
  assert.deepEqual(selection.frames.map((frame) => frame.timestampMs), [0, 4000], "each timestamp is the scene's own start");
  assert.equal(selection.frames[1]?.relevance, null, "an unscored scene is returned as unscored, not given a score");
  assert.deepEqual(selection.omitted, [{ sceneId: "bad", reason: "invalid_timestamps" }]);
  assert.match(selection.summary, /The timeline has 2 scenes, fewer than 4/);
});

test("exactly four scenes, one per quarter: each quarter's scene is chosen at its own start time", () => {
  const four = [scene("a", 0, 2000, 0.3), scene("b", 2000, 4000, 0.6), scene("c", 4000, 6000, 0.2), scene("d", 6000, 8000, 0.9)];
  const selection = selectSceneSpanFrames(four);
  assert.equal(selection.status, "selected");
  assert.equal(selection.sceneCount, 4);
  assert.deepEqual(selection.frames.map((frame) => frame.span), [1, 2, 3, 4]);
  assert.deepEqual(selection.frames.map((frame) => frame.timestampMs), [0, 2000, 4000, 6000]);
  assert.deepEqual(selection.emptySpans, []);
});

test("two scenes per quarter: the highest-relevance scene wins each quarter, not the earliest or the latest", () => {
  const selection = selectSceneSpanFrames(EIGHT);
  assert.equal(selection.status, "selected");
  assert.equal(selection.sceneCount, 8);
  assert.deepEqual(selection.frames.map((frame) => frame.sceneId), ["s1", "s3", "s4", "s7"]);
  assert.deepEqual(selection.frames.map((frame) => frame.relevance), [0.7, 0.9, 0.5, 0.8]);
  assert.equal(selection.frames.length, SCENE_FRAME_SPANS);
});

test("a tie in relevance goes to the earlier start, deterministically", () => {
  const tied = [scene("late-tie", 1500, 2000, 0.8), scene("early-tie", 500, 1000, 0.8), scene("q2", 2000, 4000, 0.1), scene("q3", 4000, 6000, 0.1), scene("q4", 6000, 8000, 0.1)];
  const selection = selectSceneSpanFrames(tied);
  assert.equal(selection.frames[0]?.sceneId, "early-tie");
  assert.equal(selection.frames[0]?.timestampMs, 500);
});

test("a tie in both relevance and start goes to the lower id, so the result never depends on input order", () => {
  const a = scene("b-id", 0, 1000, 0.5);
  const b = scene("a-id", 0, 1000, 0.5);
  const rest = [scene("q2", 2000, 4000, 0.1), scene("q3", 4000, 6000, 0.1), scene("q4", 6000, 8000, 0.1)];
  const forward = selectSceneSpanFrames([a, b, ...rest]);
  const reversed = selectSceneSpanFrames([...rest].reverse().concat([b, a]));
  assert.equal(forward.frames[0]?.sceneId, "a-id");
  assert.deepEqual(forward, reversed);
});

test("a span with no scored scene stays empty: no frame or timestamp is invented for it", () => {
  const withEmpty = [scene("a", 0, 2000, null), scene("b", 2000, 4000, 0.6), scene("c", 4000, 6000, 0.2), scene("d", 6000, 8000, 0.9)];
  const selection = selectSceneSpanFrames(withEmpty);
  assert.equal(selection.status, "partial");
  assert.deepEqual(selection.emptySpans, [1]);
  assert.deepEqual(selection.frames.map((frame) => frame.span), [2, 3, 4]);
  assert.deepEqual(selection.omitted, [{ sceneId: "a", reason: "unscored" }]);
  assert.match(selection.summary, /Only 3 of 4 spans held a scored scene/);
});

test("a measured zero is a score, not a missing one: a span with only a zero-relevance scene still chooses it", () => {
  const zeros = [scene("zero", 0, 2000, 0), scene("b", 2000, 4000, 0.4), scene("c", 4000, 6000, 0.4), scene("d", 6000, 8000, 0.4)];
  const selection = selectSceneSpanFrames(zeros);
  assert.equal(selection.status, "selected");
  assert.equal(selection.frames[0]?.sceneId, "zero");
  assert.equal(selection.frames[0]?.relevance, 0);
});

test("a non-finite relevance is treated as unscored, never as a number", () => {
  const bad = [scene("nan", 0, 2000, Number.POSITIVE_INFINITY), scene("b", 2000, 4000, 0.4), scene("c", 4000, 6000, 0.4), scene("d", 6000, 8000, 0.4)];
  const selection = selectSceneSpanFrames(bad);
  assert.deepEqual(selection.emptySpans, [1]);
  assert.deepEqual(selection.omitted, [{ sceneId: "nan", reason: "unscored" }]);
});

test("a stated duration sets the quarters; a scene that starts after the stated end is not a frame of this video", () => {
  // Stated 20 s, so the quarters are 5 s wide. The scene at 16 s has its midpoint at 16.5 s, inside the last quarter.
  const stated = [scene("a", 0, 2000, 0.1), scene("b", 6000, 8000, 0.5), scene("c", 11000, 12000, 0.2), scene("d", 16000, 17000, 0.9)];
  const selection = selectSceneSpanFrames(stated, { durationMs: 20_000 });
  assert.equal(selection.durationMs, 20_000);
  assert.deepEqual(selection.frames.map((frame) => frame.span), [1, 2, 3, 4]);
  assert.equal(selection.frames[3]?.sceneId, "d");

  const overrun = [...stated, scene("late", 30000, 31000, 0.99)];
  const withOverrun = selectSceneSpanFrames(overrun, { durationMs: 20_000 });
  assert.deepEqual(withOverrun.omitted.filter((entry) => entry.reason === "outside_timeline"), [{ sceneId: "late", reason: "outside_timeline" }]);
  assert.equal(withOverrun.frames.some((frame) => frame.sceneId === "late"), false);
});

test("without a stated duration, the quarters span the scenes themselves, and no time is assumed past the last scene", () => {
  const selection = selectSceneSpanFrames(EIGHT);
  assert.equal(selection.durationMs, 8000);
});

test("the frame's timestamp is the scene's own start, never an estimate", () => {
  const selection = selectSceneSpanFrames(EIGHT);
  for (const frame of selection.frames) {
    const source = EIGHT.find((entry) => entry.id === frame.sceneId);
    assert.equal(frame.timestampMs, source?.startMs);
  }
});

test("a keyframe reference travels with the frame when the scene has one, and is absent otherwise", () => {
  const keyed = EIGHT.map((entry) => (entry.id === "s3" ? { ...entry, keyframeRef: "kf/s3.png" } : entry));
  const selection = selectSceneSpanFrames(keyed);
  assert.equal(selection.frames.find((frame) => frame.sceneId === "s3")?.keyframeRef, "kf/s3.png");
  assert.equal("keyframeRef" in (selection.frames.find((frame) => frame.sceneId === "s1") ?? {}), false);
});
