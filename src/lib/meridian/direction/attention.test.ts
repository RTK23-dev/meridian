import assert from "node:assert/strict";
import test from "node:test";
import { attentionFindings, specificityMarkers, timeline, PICTURE_BEAT_MS } from "./attention.ts";
import { STRONG_SCRIPT, WEAK_SCRIPT } from "./fixtures.ts";
import type { DirectedScript } from "./script.ts";

const checksOf = (script: DirectedScript, options?: Parameters<typeof attentionFindings>[1]) =>
  attentionFindings(script, options).findings.map((finding) => `${finding.check}:${finding.beatId ?? "-"}:${finding.severity}`);

test("beats are laid end to end: a planned length, else the words at the pace, else a picture beat's hold", () => {
  const laid = timeline(
    [
      { beatId: "b1", role: "hook", voice: "one two three four five six", durationMs: 1500 },
      { beatId: "b2", role: "setup", voice: "one two three four five six" },
      { beatId: "b3", role: "payoff", voice: "" },
    ],
    180,
  );
  assert.deepEqual(
    laid.map((beat) => [beat.beatId, beat.startMs, beat.endMs, beat.estimated]),
    [
      ["b1", 0, 1500, false],
      ["b2", 1500, 3500, true],
      ["b3", 3500, 3500 + PICTURE_BEAT_MS, true],
    ],
  );
  assert.throws(() => timeline([], 0), /positive/);
});

test("the strong fixture passes every attention check except the info notes", () => {
  const { findings, metrics } = attentionFindings(STRONG_SCRIPT, { wordsPerMinute: 165 });
  assert.deepEqual(
    findings.filter((finding) => finding.severity !== "info"),
    [],
  );
  assert.ok(metrics.payoffStartFraction !== null && metrics.payoffStartFraction > 0.5);
  assert.ok(metrics.hookEndMs <= 3000, `the hook ends at ${metrics.hookEndMs} ms`);
  assert.ok(metrics.hookSpecificityMarkers >= 2, "three mugs, two hours, and the 1 on screen are specific");
});

test("the weak fixture fails on structure: the answer in the hook, a loop that closes before it opens, a chain of additions", () => {
  const checks = checksOf(WEAK_SCRIPT, { wordsPerMinute: 165 });
  assert.ok(checks.includes("hook_answers_itself:b1:warn"));
  assert.ok(checks.includes("loops_close:-:block"));
  assert.ok(checks.includes("and_chain:b4:warn"));
  assert.ok(checks.includes("and_chain:b5:warn"));
  assert.ok(checks.includes("hook_length:b1:warn"), "the hook's 24 words run past 6 s");
  assert.ok(checks.includes("hook_text_length:b1:warn"));
  assert.ok(checks.includes("ends_after_payoff:b2:warn"), "it goes on after the hook paid the promise");
});

test("a script that does not open on its hook, or names a promise beat that does not exist, is refused", () => {
  const script: DirectedScript = {
    ...STRONG_SCRIPT,
    promise: { ...STRONG_SCRIPT.promise, paidByBeatId: "b9" },
    beats: [{ ...STRONG_SCRIPT.beats[1]!, beatId: "b1", link: undefined }, ...STRONG_SCRIPT.beats.slice(1)],
  };
  const checks = checksOf(script);
  assert.ok(checks.includes("hook_first:b1:block"));
  assert.ok(checks.includes("promise_paid:-:block"));
  assert.ok(checks.includes("beat_ids:b1:block") === false);
});

test("a long beat, a fast voice, fast on-screen text and a duplicated beat id are each found", () => {
  const script: DirectedScript = {
    ...STRONG_SCRIPT,
    beats: [
      { ...STRONG_SCRIPT.beats[0]!, durationMs: 2000 },
      { beatId: "b2", role: "setup", voice: "one two three four five six seven eight nine ten eleven twelve", durationMs: 2000, picture: "p", onScreenText: "a b c d e f g h i j k l m n o p q r s t u v w x y", link: "but" },
      { beatId: "b2", role: "item", voice: "slow", durationMs: 9000, picture: "p", link: "therefore" },
      ...STRONG_SCRIPT.beats.slice(3),
    ],
  };
  const checks = checksOf(script);
  assert.ok(checks.includes("voice_rate:b2:warn"), "six words a second");
  assert.ok(checks.includes("text_rate:b2:warn"), "25 words in 2 s");
  assert.ok(checks.includes("max_stretch:b2:warn"), "9 s with no change");
  assert.ok(checks.includes("beat_ids:b2:block"));
});

test("the windows can be overridden by the caller", () => {
  const strict = checksOf(STRONG_SCRIPT, { windows: { hookEndsByMs: 1000, maxStretchMs: 2000 } });
  assert.ok(strict.includes("hook_length:b1:warn"));
  assert.ok(strict.some((check) => check.startsWith("max_stretch:")));
});

test("specificity markers count numbers, symbols, number words and names after a sentence's first word", () => {
  assert.equal(specificityMarkers("Save money on groceries"), 0);
  assert.ok(specificityMarkers("I spent €41 at Lidl in two days") >= 3);
});
