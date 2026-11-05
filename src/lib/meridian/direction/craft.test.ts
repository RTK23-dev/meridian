import assert from "node:assert/strict";
import test from "node:test";
import { DIRECTION_WINDOWS } from "./codex.ts";
import { timeline } from "./attention.ts";
import { craftFindings, readingGrade, rhythmVariation, sentencesOf, syllables } from "./craft.ts";
import { STRONG_SCRIPT } from "./fixtures.ts";
import type { DirectedBeat, DirectedScript } from "./script.ts";

const run = (script: DirectedScript, windows = DIRECTION_WINDOWS) => craftFindings(script, timeline(script.beats, windows.defaultWordsPerMinute), windows);
const checks = (script: DirectedScript, windows = DIRECTION_WINDOWS) =>
  run(script, windows)
    .filter((finding) => finding.severity !== "info")
    .map((finding) => finding.check);
const withBeat = (index: number, change: Partial<DirectedBeat>): DirectedScript => ({
  ...STRONG_SCRIPT,
  beats: STRONG_SCRIPT.beats.map((beat, at) => (at === index ? { ...beat, ...change } : beat)),
});

test("the strong fixture passes every craft check", () => {
  assert.deepEqual(run(STRONG_SCRIPT), []);
});

test("context first: line 1 or the text hook must name the topic", () => {
  assert.deepEqual(checks(withBeat(0, { voice: "Same pot. Two hours.", onScreenText: "Only 1 stays warm" })), ["context_first"]);
  assert.deepEqual(checks(withBeat(0, { voice: "Same pot. Two hours.", onScreenText: "Only 1 mug stays warm" })), [], "the text hook can carry the context");
});

test("the first two sentences carry at most 15 words", () => {
  const long = withBeat(0, { voice: "Three mugs filled with the same coffee from the same pot at the same minute. Two hours on the clock." });
  assert.ok(checks(long).includes("opening_overload"));
});

test("an if-then hook is flagged; a declarative one is not", () => {
  assert.ok(checks(withBeat(0, { voice: "If you want hot coffee, buy the right mug." })).includes("if_then_hook"));
  assert.ok(!checks(withBeat(0, { voice: "Buy the right mug to keep coffee hot." })).includes("if_then_hook"));
});

test("the double hook and the hourglass: a long video with no new peak is flagged", () => {
  const flat: DirectedScript = {
    ...STRONG_SCRIPT,
    loops: [{ question: "Which mug wins", opensAt: "b1", closesAt: "b6" }],
    rehooks: [],
    ahas: [],
    beats: STRONG_SCRIPT.beats.map((beat, index) => ({ ...beat, role: index === 0 ? "hook" : index === 5 ? "payoff" : "item", durationMs: index === 0 ? 2000 : 6000 })),
  };
  const found = checks(flat);
  assert.ok(found.includes("double_hook"), found.join(","));
  assert.ok(found.includes("peak_gap"), "0 s to the payoff at 26 s with nothing new");
});

test("zig-zag rhythm: sentences of one length are a flat line", () => {
  const flat: DirectedScript = {
    ...STRONG_SCRIPT,
    beats: STRONG_SCRIPT.beats.map((beat) => ({ ...beat, voice: "This mug is hot now. That mug is cold now." })),
  };
  assert.ok(checks(flat).includes("rhythm"));
  assert.ok(rhythmVariation([2, 2, 2, 9, 9, 12, 5, 4, 14]) > 0.35);
  assert.equal(rhythmVariation([5, 5, 5]), 0);
});

test("reading level: long words in long sentences are flagged; syllables and grades are rough but ordered", () => {
  const dense = withBeat(1, { voice: "Thermodynamically, vacuum-insulated stainless containers demonstrate substantially superior thermal retention characteristics compared with conventional borosilicate glassware alternatives." });
  assert.ok(checks(dense).includes("reading_level"));
  assert.equal(syllables("mug"), 1);
  assert.equal(syllables("coffee"), 2);
  assert.ok(syllables("thermodynamically") >= 5);
  assert.ok((readingGrade("The mug is hot. It stays hot.") ?? 99) < (readingGrade("Thermodynamic retention characteristics substantially outperform conventional alternatives.") ?? 0));
  assert.equal(readingGrade(""), null);
  assert.deepEqual(sentencesOf("One. Two words! Three words here?"), ["One", "Two words", "Three words here"]);
});

test("the text hook keeps to power words: no filler words, no punctuation but parentheses and quotes", () => {
  assert.ok(checks(withBeat(0, { onScreenText: "So this mug stays hot, really!" })).includes("text_hook_style"));
  assert.deepEqual(checks(withBeat(0, { onScreenText: '1 mug stays hot (2 hours) "61°" $2,700' })), [], "figures, symbols, parentheses and quotes are allowed");
  assert.deepEqual(checks(withBeat(0, { onScreenText: "0→100K mugs in 22 days" })), []);
});

test("the lock-in and the trust anchor belong right after the hook", () => {
  assert.ok(checks({ ...STRONG_SCRIPT, lockIn: { approach: "tease_proof", beatId: "b5" } }).includes("lock_in"));
  assert.ok(checks({ ...STRONG_SCRIPT, lockIn: { approach: "tease_proof", beatId: "b9" } }).includes("lock_in"));
  assert.ok(checks({ ...STRONG_SCRIPT, trustAnchor: { type: "direct_results", beatId: "b6" } }).includes("trust_anchor"));
  const none = run({ ...STRONG_SCRIPT, trustAnchor: null }).filter((finding) => finding.check === "trust_anchor");
  assert.deepEqual(none.map((finding) => finding.severity), ["info"], "no proof in the brief is a note, never an invention");
});

test("an educational format needs a villain; an application format does not", () => {
  assert.ok(checks({ ...STRONG_SCRIPT, format: "listicle", villain: null }).includes("villain"));
  assert.ok(!checks({ ...STRONG_SCRIPT, format: "test_experiment", villain: null }).includes("villain"));
});

test("the double aha: two non-obvious moments, the second early enough", () => {
  assert.ok(checks({ ...STRONG_SCRIPT, ahas: [{ text: "one", beatId: "b4" }] }).includes("double_aha"));
  assert.ok(checks({ ...STRONG_SCRIPT, ahas: [{ text: "one", beatId: "b4" }, { text: "late", beatId: "b6" }] }).includes("double_aha"));
});

test("a pattern interrupt needs a matching sound", () => {
  const silent = withBeat(0, { sound: undefined });
  assert.ok(checks({ ...silent, hookFamily: "pattern_interrupt" }).includes("hook_sound"));
  assert.deepEqual(
    run(silent).filter((finding) => finding.check === "hook_sound").map((finding) => finding.severity),
    ["info"],
  );
});

test("the call to action fits the job and names the topic", () => {
  const ctaBeat: DirectedBeat = { beatId: "b7", role: "cta", voice: "Comment MUGS and I will send you the full heat test.", picture: "The three mugs", link: "therefore" };
  const convert: DirectedScript = { ...STRONG_SCRIPT, job: "convert", beats: [...STRONG_SCRIPT.beats, ctaBeat], cta: { beatId: "b7", keyword: "MUGS", offer: "The full mug heat test" } };
  assert.deepEqual(checks(convert), []);
  assert.ok(checks({ ...STRONG_SCRIPT, job: "convert" }).includes("cta_alignment"), "a convert video with no CTA");
  assert.ok(checks({ ...convert, cta: { beatId: "b7", keyword: "MUGS", offer: "My free newsletter" } }).includes("cta_alignment"), "an offer that does not name the topic");
  assert.ok(checks({ ...convert, cta: { beatId: "b7", keyword: "HEAT", offer: "The full mug heat test" } }).includes("cta_alignment"), "a keyword that is never said");
  const reach = run({ ...convert, job: "reach" }).filter((finding) => finding.check === "cta_alignment");
  assert.deepEqual(reach.map((finding) => finding.severity), ["info"]);
});

test("an older script without the version 2 fields is checked only where it can be", () => {
  const { topic: _topic, job: _job, lockIn: _lockIn, trustAnchor: _trustAnchor, villain: _villain, ahas: _ahas, rehooks: _rehooks, cta: _cta, ...v1 } = STRONG_SCRIPT;
  assert.deepEqual(run(v1 as DirectedScript), []);
});

test("another language skips the English-only checks and says so", () => {
  const german = { ...STRONG_SCRIPT, language: "de" };
  const notes = run(german).filter((finding) => finding.severity === "info");
  assert.ok(notes.some((finding) => /English only/.test(finding.message)));
});

const STITCH: DirectedScript = {
  ...STRONG_SCRIPT,
  hookFamily: "clip_stitch",
  beats: [
    {
      beatId: "b1",
      role: "hook",
      voice: "",
      onScreenText: "This mug test went viral",
      picture: "The viral mug clip, as it was posted",
      sound: "The original clip's audio",
      durationMs: 3000,
      borrowed: { source: "https://www.tiktok.com/@maker/video/1", credit: "@maker" },
    },
    { ...STRONG_SCRIPT.beats[1]!, voice: "But they tested the wrong mug. I tested three for two hours." },
    ...STRONG_SCRIPT.beats.slice(2),
  ],
};

test("a clip-stitch opening that keeps the rule passes: first beat only, planned, short, then the brand's own take", () => {
  assert.deepEqual(
    run(STITCH).filter((finding) => finding.check === "borrowed_clip"),
    [],
  );
});

test("a borrowed clip anywhere but the opening, too long, or unplanned fails; its own voice or a silent follow-up is warned", () => {
  const severities = (script: DirectedScript) =>
    run(script)
      .filter((finding) => finding.check === "borrowed_clip")
      .map((finding) => `${finding.beatId}:${finding.severity}`);
  assert.deepEqual(severities({ ...STITCH, beats: [STITCH.beats[0]!, { ...STITCH.beats[1]!, borrowed: { source: "x", credit: "@x" } }, ...STITCH.beats.slice(2)] }), ["b2:block"]);
  assert.deepEqual(severities({ ...STITCH, beats: [{ ...STITCH.beats[0]!, durationMs: 9000 }, ...STITCH.beats.slice(1)] }), ["b1:block"]);
  const { durationMs: _unplanned, ...unplanned } = STITCH.beats[0]!;
  assert.deepEqual(severities({ ...STITCH, beats: [unplanned, ...STITCH.beats.slice(1)] }), ["b1:block"]);
  assert.deepEqual(severities({ ...STITCH, beats: [{ ...STITCH.beats[0]!, voice: "Their words" }, ...STITCH.beats.slice(1)] }), ["b1:warn"]);
  assert.deepEqual(severities({ ...STITCH, beats: [STITCH.beats[0]!, { ...STITCH.beats[1]!, voice: "" }, ...STITCH.beats.slice(2)] }), ["b2:warn"]);
  assert.deepEqual(severities({ ...STRONG_SCRIPT, hookFamily: "clip_stitch" }), ["b1:warn"], "a clip-stitch hook must declare its clip");
});
