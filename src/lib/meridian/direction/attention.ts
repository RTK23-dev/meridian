// The attention checks (framework 1.3, 4, 5, 6 and 10): what can be measured about a directed script before anything is made. It lays the
// beats on a timeline (the writer's durations, or the voice at its pace), then checks the structure the writer declared against the
// windows in the codex: the hook comes first and ends in time, the promise is paid later and not in the hook, every loop closes, no beat
// runs too long without a change, the video stops after its payoff, and the on-screen text can be read.
//
// These checks find known failure modes. They do not predict a hit (framework 3.3). Pure.

import { DIRECTION_WINDOWS, type DirectionWindows } from "./codex.ts";
import type { ScriptFinding } from "./slop.ts";
import type { DirectedBeat, DirectedScript } from "./script.ts";

/** A beat with no voice and no planned length is held this long (initial): long enough to read a picture. */
export const PICTURE_BEAT_MS = 1200;

export type TimedBeat = { beatId: string; index: number; startMs: number; endMs: number; words: number; estimated: boolean };

export type AttentionMetrics = {
  durationMs: number;
  hookEndMs: number;
  /** The paying beat's start as a fraction of the duration. Null when the promise names no beat of the script. */
  payoffStartFraction: number | null;
  longestBeatMs: number;
  voiceWords: number;
  /** Spoken words estimated to fall inside the promise window. */
  wordsBeforePromiseBy: number;
  /** Numbers, names and symbols in the hook beat: a rough measure of a specific hook. */
  hookSpecificityMarkers: number;
};

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'-]*/gu;
const NUMBER_WORDS =
  /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred|thousand|million|half|dozen|once|twice)\b/i;

export function wordCount(text: string): number {
  return text.match(WORD)?.length ?? 0;
}

/** Each beat's place on the timeline: its own planned length, else its words at the pace, else a picture beat's hold. */
export function timeline(beats: readonly DirectedBeat[], wordsPerMinute: number): TimedBeat[] {
  if (!(wordsPerMinute > 0) || !Number.isFinite(wordsPerMinute)) throw new Error("The pace must be a positive number of words per minute.");
  let cursor = 0;
  return beats.map((beat, index) => {
    const words = wordCount(beat.voice);
    const estimated = beat.durationMs === undefined;
    const length = beat.durationMs ?? (words > 0 ? Math.round((words * 60_000) / wordsPerMinute) : PICTURE_BEAT_MS);
    const timed: TimedBeat = { beatId: beat.beatId, index, startMs: cursor, endMs: cursor + length, words, estimated };
    cursor += length;
    return timed;
  });
}

/** Numbers, number words, currency and percent signs, and capitalised words after the first word of a sentence (a proxy for names). */
export function specificityMarkers(text: string): number {
  let count = 0;
  count += text.match(/\d+(?:[.,]\d+)?/g)?.length ?? 0;
  count += text.match(/[%$€£¥]/g)?.length ?? 0;
  if (NUMBER_WORDS.test(text)) count += 1;
  for (const sentence of text.split(/[.!?]+/)) {
    const tokens = sentence.trim().split(/\s+/).slice(1);
    count += tokens.filter((token) => /^\p{Lu}\p{Ll}+/u.test(token) && token !== "I").length;
  }
  return count;
}

function normalized(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * The attention findings and metrics of a script. `wordsPerMinute` is the voice's pace; the codex's default is used when it is not known.
 */
export function attentionFindings(
  script: DirectedScript,
  options: { windows?: Partial<DirectionWindows>; wordsPerMinute?: number } = {},
): { findings: ScriptFinding[]; metrics: AttentionMetrics; timeline: TimedBeat[] } {
  const windows: DirectionWindows = { ...DIRECTION_WINDOWS, ...options.windows };
  const pace = options.wordsPerMinute ?? windows.defaultWordsPerMinute;
  const timed = timeline(script.beats, pace);
  const durationMs = timed.at(-1)?.endMs ?? 0;
  const findings: ScriptFinding[] = [];
  const indexOf = new Map(script.beats.map((beat, index) => [beat.beatId, index]));
  const seconds = (ms: number) => (ms / 1000).toFixed(1);

  const ids = new Set<string>();
  for (const beat of script.beats) {
    if (ids.has(beat.beatId)) {
      findings.push({ check: "beat_ids", severity: "block", evidence: "hypothesis", beatId: beat.beatId, message: `Beat id ${beat.beatId} is used twice. Each beat has its own id.` });
    }
    ids.add(beat.beatId);
  }

  const first = script.beats[0];
  const firstTimed = timed[0];
  if (!first || !firstTimed) {
    return { findings, metrics: emptyMetrics(), timeline: timed };
  }

  // 1. The hook comes first, ends in time, and states its promise early.
  if (first.role !== "hook") {
    findings.push({ check: "hook_first", severity: "block", evidence: "sourced", beatId: first.beatId, message: `The first beat is a ${first.role}. The hook is the first beat: no intro before it.` });
  }
  if (firstTimed.endMs > windows.hookEndsByMs) {
    findings.push({
      check: "hook_length",
      severity: "warn",
      evidence: "sourced",
      beatId: first.beatId,
      message: `The hook runs to ${seconds(firstTimed.endMs)} s. End it by ${seconds(windows.hookEndsByMs)} s.`,
    });
  }
  if (firstTimed.endMs > windows.promiseByMs && !(first.onScreenText ?? "").trim()) {
    findings.push({
      check: "promise_by",
      severity: "warn",
      evidence: "sourced",
      beatId: first.beatId,
      message: `The hook runs to ${seconds(firstTimed.endMs)} s with no on-screen text, so the promise may land after ${seconds(windows.promiseByMs)} s. Put the promise on screen from frame 0, or shorten the hook.`,
    });
  }

  // 2. The promise is paid by a later beat, not by the hook, and late enough to hold the viewer.
  const paying = indexOf.get(script.promise.paidByBeatId);
  let payoffStartFraction: number | null = null;
  if (paying === undefined) {
    findings.push({
      check: "promise_paid",
      severity: "block",
      evidence: "hypothesis",
      message: `The promise names beat ${script.promise.paidByBeatId}, which is not in the script. Every promise is paid by a beat of the video.`,
    });
  } else {
    const payingTimed = timed[paying];
    payoffStartFraction = durationMs > 0 && payingTimed ? payingTimed.startMs / durationMs : null;
    if (paying === 0 || (paying === 1 && script.beats.length >= 4)) {
      findings.push({
        check: "hook_answers_itself",
        severity: "warn",
        evidence: "hypothesis",
        beatId: script.promise.paidByBeatId,
        message: `The promise is paid by beat ${script.promise.paidByBeatId}, at the start. Hold the answer back: pay it in the last part of the video.`,
      });
    } else if (payoffStartFraction !== null && payoffStartFraction < windows.payoffStartsAfterFraction) {
      findings.push({
        check: "payoff_position",
        severity: "warn",
        evidence: "hypothesis",
        beatId: script.promise.paidByBeatId,
        message: `The payoff starts ${Math.round(payoffStartFraction * 100)}% of the way in. Move it after ${Math.round(windows.payoffStartsAfterFraction * 100)}%, and give the viewer smaller rewards before it.`,
      });
    }
    const after = script.beats.slice(paying + 1).filter((beat) => beat.role === "setup" || beat.role === "item" || beat.role === "proof");
    if (after.length > 0) {
      findings.push({
        check: "ends_after_payoff",
        severity: "warn",
        evidence: "sourced",
        beatId: after[0]?.beatId,
        message: `The video goes on after its payoff (${after.map((beat) => beat.beatId).join(", ")}). End on or just after the peak.`,
      });
    }
  }

  // 3. Every loop opens before it closes, and both beats exist.
  for (const loop of script.loops) {
    const opens = indexOf.get(loop.opensAt);
    const closes = indexOf.get(loop.closesAt);
    if (opens === undefined || closes === undefined || closes <= opens) {
      findings.push({
        check: "loops_close",
        severity: "block",
        evidence: "hypothesis",
        message: `The loop "${loop.question}" opens at ${loop.opensAt} and closes at ${loop.closesAt}. A loop must open at a beat of the script and close at a later one; an open loop that never closes is bait.`,
      });
    }
  }

  // 4. No beat runs too long without a change; no chain of plain additions.
  let longestBeatMs = 0;
  timed.forEach((beat) => {
    const length = beat.endMs - beat.startMs;
    longestBeatMs = Math.max(longestBeatMs, length);
    if (length > windows.maxStretchMs) {
      findings.push({
        check: "max_stretch",
        severity: "warn",
        evidence: "hypothesis",
        beatId: beat.beatId,
        message: `Beat ${beat.beatId} runs ${seconds(length)} s. Split it, or give it a visual or story change before ${seconds(windows.maxStretchMs)} s.`,
      });
    }
  });
  for (let index = 1; index < script.beats.length - 1; index += 1) {
    const beat = script.beats[index];
    const next = script.beats[index + 1];
    if (beat?.link === "and" && next?.link === "and") {
      findings.push({
        check: "and_chain",
        severity: "warn",
        evidence: "practice",
        beatId: next.beatId,
        message: `Beats ${beat.beatId} and ${next.beatId} both follow with "and". Join beats with but or therefore so each one raises the stakes.`,
      });
    }
  }

  // 5. Rates: the voice and the on-screen text can be followed.
  script.beats.forEach((beat, index) => {
    const timedBeat = timed[index];
    if (!timedBeat) return;
    const length = (timedBeat.endMs - timedBeat.startMs) / 1000;
    if (!timedBeat.estimated && length > 0 && timedBeat.words / length > windows.maxVoiceWordsPerSecond) {
      findings.push({
        check: "voice_rate",
        severity: "warn",
        evidence: "practice",
        beatId: beat.beatId,
        message: `Beat ${beat.beatId} asks for ${(timedBeat.words / length).toFixed(1)} spoken words a second. Cut words, or give the beat more time.`,
      });
    }
    const textWords = wordCount(beat.onScreenText ?? "");
    if (index === 0 && textWords > windows.maxHookTextWords) {
      findings.push({
        check: "hook_text_length",
        severity: "warn",
        evidence: "practice",
        beatId: beat.beatId,
        message: `The hook puts ${textWords} words on screen. Keep it to ${windows.maxHookTextWords}, readable in one glance.`,
      });
    }
    if (length > 0 && textWords / length > windows.maxTextWordsPerSecond) {
      findings.push({
        check: "text_rate",
        severity: "warn",
        evidence: "sourced",
        beatId: beat.beatId,
        message: `Beat ${beat.beatId} shows ${textWords} on-screen words in ${length.toFixed(1)} s, faster than ${windows.maxTextWordsPerSecond} a second.`,
      });
    }
    if (!(beat.picture ?? "").trim()) {
      findings.push({ check: "picture_missing", severity: "info", evidence: "practice", beatId: beat.beatId, message: `Beat ${beat.beatId} has no picture. Every line needs something to show.` });
    }
  });

  // 6. The hook's three channels: the text frames the question rather than repeating the voice; the hook carries something specific.
  const hookText = normalized(first.onScreenText ?? "");
  const hookVoice = normalized(first.voice);
  if (hookText.length > 0 && hookVoice.length > 0 && wordCount(hookText) >= 5 && hookVoice.includes(hookText)) {
    findings.push({
      check: "text_echoes_voice",
      severity: "info",
      evidence: "practice",
      beatId: first.beatId,
      message: "The hook's on-screen text repeats the voice word for word. Let the text frame the question and the voice raise the stakes.",
    });
  }
  const hookSpecificityMarkers = specificityMarkers(`${first.voice} ${first.onScreenText ?? ""}`);
  if (hookSpecificityMarkers === 0) {
    findings.push({
      check: "specificity",
      severity: "info",
      evidence: "practice",
      beatId: first.beatId,
      message: "The hook has no number, name or other specific marker. Specific beats general, but only with facts the brief gives.",
    });
  }

  const wordsBeforePromiseBy = timed.reduce((total, beat) => {
    const length = beat.endMs - beat.startMs;
    if (length <= 0 || beat.startMs >= windows.promiseByMs) return total;
    const inside = Math.min(beat.endMs, windows.promiseByMs) - beat.startMs;
    return total + Math.round((beat.words * inside) / length);
  }, 0);

  return {
    findings,
    timeline: timed,
    metrics: {
      durationMs,
      hookEndMs: firstTimed.endMs,
      payoffStartFraction,
      longestBeatMs,
      voiceWords: timed.reduce((total, beat) => total + beat.words, 0),
      wordsBeforePromiseBy,
      hookSpecificityMarkers,
    },
  };
}

function emptyMetrics(): AttentionMetrics {
  return { durationMs: 0, hookEndMs: 0, payoffStartFraction: null, longestBeatMs: 0, voiceWords: 0, wordsBeforePromiseBy: 0, hookSpecificityMarkers: 0 };
}
