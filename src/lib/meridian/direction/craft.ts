// The craft checks of codex version 2 (framework 4 to 9; the Kallaway lessons in docs/direction/LESSONS_CROSSWALK.md): what can be measured
// of the hook's context and length, the rehook cadence, the rhythm and reading level of the voice, the text hook's style, and the
// structure the writer declares (the lock-in, the trust anchor, the villain, the ahas, the call to action). They find failures that one
// creator's data and practice point to; none of them predicts a hit, and each is a warning or a note, never a block.
//
// A check whose input the script does not declare (an older script without the version 2 fields) is not run. Checks that read English
// words say so for another language. Pure.

import { contentWords } from "./concepts.ts";
import { formatArchetype, type DirectionWindows } from "./codex.ts";
import type { TimedBeat } from "./attention.ts";
import { isEnglish, type ScriptFinding } from "./slop.ts";
import type { DirectedScript } from "./script.ts";

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'-]*/gu;
const FILLER_WORDS = new Set(["and", "but", "therefore", "so", "then", "just", "really", "very", "actually", "basically", "because"]);

function words(text: string): string[] {
  return text.match(WORD) ?? [];
}

/** The sentences of a text: split at full stops, question and exclamation marks; empty pieces dropped. */
export function sentencesOf(text: string): string[] {
  return text
    .split(/[.!?]+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => words(sentence).length > 0);
}

/** A rough syllable count of an English word: vowel groups, less a silent final e. Never below 1. */
export function syllables(word: string): number {
  const lower = word.toLowerCase().replace(/[^a-z]/g, "");
  if (lower.length === 0) return 1;
  const groups = lower.match(/[aeiouy]+/g)?.length ?? 0;
  const silentE = lower.length > 2 && /[^aeiouy]e$/.test(lower) && !lower.endsWith("le") && groups > 1 ? 1 : 0;
  return Math.max(1, groups - silentE);
}

/** The Flesch-Kincaid grade of an English text, or null when it has no words. */
export function readingGrade(text: string): number | null {
  const all = words(text);
  const sentenceCount = Math.max(1, sentencesOf(text).length);
  if (all.length === 0) return null;
  const syllableCount = all.reduce((total, word) => total + syllables(word), 0);
  return 0.39 * (all.length / sentenceCount) + 11.8 * (syllableCount / all.length) - 15.59;
}

/** How much sentence lengths vary: the standard deviation over the mean. 0 means every sentence is as long as the others. */
export function rhythmVariation(lengths: readonly number[]): number {
  if (lengths.length === 0) return 0;
  const mean = lengths.reduce((total, length) => total + length, 0) / lengths.length;
  if (mean === 0) return 0;
  const variance = lengths.reduce((total, length) => total + (length - mean) ** 2, 0) / lengths.length;
  return Math.sqrt(variance) / mean;
}

/** A word with a plural ending taken off, so "mugs" meets "mug". */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

function sharesWord(a: string, b: string): boolean {
  const left = new Set([...contentWords(a)].map(stem));
  for (const word of contentWords(b)) if (left.has(stem(word))) return true;
  return false;
}

/** The text hook with the punctuation the rules allow taken out: parentheses, quotes, figures, arrows, symbols and in-word marks. */
function strayPunctuation(text: string): string[] {
  const cleaned = text
    .replace(/[()"“”‘’]/g, " ")
    .replace(/(\d)[.,](\d)/g, "$1$2")
    .replace(/->|→/g, " ")
    .replace(/[%$€£¥+]/g, " ")
    .replace(/(\p{L})['-](\p{L})/gu, "$1$2");
  return [...new Set(cleaned.match(/[.,!?;:—–…-]/g) ?? [])];
}

/** The craft findings of a script on its timeline. */
export function craftFindings(script: DirectedScript, timed: readonly TimedBeat[], windows: DirectionWindows): ScriptFinding[] {
  const findings: ScriptFinding[] = [];
  const first = script.beats[0];
  if (!first) return findings;
  const english = isEnglish(script.language);
  const durationMs = timed.at(-1)?.endMs ?? 0;
  const indexOf = new Map(script.beats.map((beat, index) => [beat.beatId, index]));
  const startOf = (beatId: string) => {
    const index = indexOf.get(beatId);
    return index === undefined ? undefined : timed[index]?.startMs;
  };
  const seconds = (ms: number) => (ms / 1000).toFixed(1);
  const voice = script.beats.map((beat) => beat.voice).join(" ");
  const firstSentence = sentencesOf(first.voice)[0] ?? "";
  const hookText = first.onScreenText ?? "";

  // Context first: line 1 or the text hook names the topic.
  if (script.topic !== undefined && !sharesWord(script.topic, `${firstSentence} ${hookText}`)) {
    findings.push({
      check: "context_first",
      severity: "warn",
      evidence: "practice",
      beatId: first.beatId,
      message: `Line 1 does not name the topic ("${script.topic}"). Name it in the first sentence or the text hook, so the viewer knows at once the video is for them.`,
    });
  }

  // The first two sentences carry at most the opening word limit.
  const opening = sentencesOf(voice).slice(0, 2);
  const openingWords = opening.reduce((total, sentence) => total + words(sentence).length, 0);
  if (openingWords > windows.maxOpeningWords) {
    findings.push({
      check: "opening_overload",
      severity: "warn",
      evidence: "practice",
      beatId: first.beatId,
      message: `The first two sentences run ${openingWords} words. Keep them to ${windows.maxOpeningWords}: an overloaded hook is skipped.`,
    });
  }

  // Declarative, not if-then.
  if (english && [firstSentence, hookText].some((line) => /^\s*if\s+(?:you|you're|your)\b/i.test(line) || /\bif you want\b/i.test(line))) {
    findings.push({
      check: "if_then_hook",
      severity: "warn",
      evidence: "practice",
      beatId: first.beatId,
      message: "The hook opens with if-then. Say it as a fact: 'Do Y to get X', not 'If you want X, do Y'.",
    });
  }

  // Peaks: turns, loops opened after the hook, declared rehooks and ahas, and the payoff.
  const payingStart = startOf(script.promise.paidByBeatId);
  const peakStarts = new Set<number>([0]);
  script.beats.forEach((beat, index) => {
    if (index > 0 && beat.role === "twist") peakStarts.add(timed[index]?.startMs ?? 0);
  });
  for (const loop of script.loops) {
    const start = startOf(loop.opensAt);
    if (start !== undefined && start > 0) peakStarts.add(start);
  }
  for (const beatId of [...(script.rehooks ?? []), ...(script.ahas ?? []).map((aha) => aha.beatId)]) {
    const start = startOf(beatId);
    if (start !== undefined && start > 0) peakStarts.add(start);
  }
  if (payingStart !== undefined) peakStarts.add(payingStart);
  const peaks = [...peakStarts].sort((a, b) => a - b);

  if (durationMs > windows.doubleHookAfterMs && !peaks.some((start) => start > 0 && start <= windows.doubleHookByMs)) {
    findings.push({
      check: "double_hook",
      severity: "warn",
      evidence: "practice",
      message: `Nothing new opens in the first ${seconds(windows.doubleHookByMs)} s after the hook. Rehook with extra contrast, a headfake or a second loop, by then.`,
    });
  }
  const horizon = payingStart ?? durationMs;
  const before = [...peaks.filter((start) => start <= horizon), horizon];
  for (let index = 1; index < before.length; index += 1) {
    const gap = before[index]! - before[index - 1]!;
    if (gap > windows.maxPeakGapMs) {
      findings.push({
        check: "peak_gap",
        severity: "warn",
        evidence: "practice",
        message: `From ${seconds(before[index - 1]!)} s to ${seconds(before[index]!)} s nothing new happens: ${seconds(gap)} s, past the ${seconds(windows.maxPeakGapMs)} s a short video's attention lasts. Flip into a new part with a turn that opens a loop.`,
      });
      break;
    }
  }

  // Zig-zag rhythm.
  const lengths = sentencesOf(voice).map((sentence) => words(sentence).length);
  if (lengths.length >= windows.rhythmMinSentences && rhythmVariation(lengths) < windows.minRhythmVariation) {
    findings.push({
      check: "rhythm",
      severity: "warn",
      evidence: "practice",
      message: `The sentences run ${lengths.join(", ")} words: a flat line. Mix short, medium and long, with short punchy resets.`,
    });
  }

  // Simple words: the reading grade of the voice.
  if (english) {
    const grade = readingGrade(voice);
    if (grade !== null && words(voice).length >= 20 && grade > windows.maxReadingGrade) {
      findings.push({
        check: "reading_level",
        severity: "warn",
        evidence: "practice",
        message: `The voice reads at about grade ${grade.toFixed(1)}. Use simpler words and shorter sentences: aim at grade ${windows.maxReadingGrade} or under.`,
      });
    }
  }

  // The text hook's style.
  if (hookText.trim()) {
    const fillers = english ? [...new Set((hookText.toLowerCase().match(/\p{L}+/gu) ?? []).filter((word) => FILLER_WORDS.has(word)))] : [];
    const stray = strayPunctuation(hookText);
    if (fillers.length > 0 || stray.length > 0) {
      const parts = [fillers.length > 0 ? `filler words (${fillers.join(", ")})` : "", stray.length > 0 ? `punctuation (${stray.join(" ")})` : ""].filter(Boolean);
      findings.push({
        check: "text_hook_style",
        severity: "warn",
        evidence: "practice",
        beatId: first.beatId,
        message: `The text hook has ${parts.join(" and ")}. Keep the subject and power words; no punctuation but parentheses and quotes.`,
      });
    }
  }

  // The lock-in zone: the beat after the hook, early.
  if (script.lockIn) {
    const index = indexOf.get(script.lockIn.beatId);
    const start = startOf(script.lockIn.beatId);
    if (index === undefined || start === undefined) {
      findings.push({ check: "lock_in", severity: "warn", evidence: "practice", message: `The lock-in names beat ${script.lockIn.beatId}, which is not in the script.` });
    } else if (index === 0 || index > 2 || start > windows.lockInByMs) {
      findings.push({
        check: "lock_in",
        severity: "warn",
        evidence: "practice",
        beatId: script.lockIn.beatId,
        message: `The lock-in is beat ${script.lockIn.beatId}, at ${seconds(start)} s. It belongs in the two or three sentences right after the hook.`,
      });
    }
  }

  // The trust anchor: proof early, or none when the brief gives none.
  if (script.trustAnchor === null) {
    findings.push({
      check: "trust_anchor",
      severity: "info",
      evidence: "practice",
      message: "No trust anchor: the brief gives no proof, so the script must make no claim that needs one.",
    });
  } else if (script.trustAnchor) {
    const index = indexOf.get(script.trustAnchor.beatId);
    const start = startOf(script.trustAnchor.beatId);
    if (index === undefined || start === undefined || (index > 2 && start > windows.lockInByMs)) {
      findings.push({
        check: "trust_anchor",
        severity: "warn",
        evidence: "practice",
        beatId: script.trustAnchor.beatId,
        message: `The proof (${script.trustAnchor.type.replace(/_/g, " ")}) arrives at beat ${script.trustAnchor.beatId}. Put it in the hook's second line or the lock-in, so a bold claim is believed before the viewer decides.`,
      });
    }
  }

  // An educational video needs a villain.
  const level = formatArchetype(script.format).level;
  if (script.villain === null && (level === "facts" || level === "explanation")) {
    findings.push({
      check: "villain",
      severity: "warn",
      evidence: "practice",
      message: `A ${formatArchetype(script.format).name.toLowerCase()} teaches, and teaching needs a villain: the old way, a false belief, or the frustration they cause.`,
    });
  }

  // The double aha: two non-obvious moments, the second early enough.
  if (script.ahas) {
    if (script.ahas.length < 2) {
      findings.push({ check: "double_aha", severity: "warn", evidence: "practice", message: `The script declares ${script.ahas.length} aha. Front-load two non-obvious lightbulb moments.` });
    } else {
      const secondStart = startOf(script.ahas[1]!.beatId);
      if (secondStart === undefined || (durationMs > 0 && secondStart / durationMs > windows.secondAhaByFraction)) {
        findings.push({
          check: "double_aha",
          severity: "warn",
          evidence: "practice",
          beatId: script.ahas[1]!.beatId,
          message: `The second aha comes ${secondStart === undefined ? "at a beat not in the script" : `${Math.round((secondStart / durationMs) * 100)}% of the way in`}. Bring it into the first ${Math.round(windows.secondAhaByFraction * 100)}%.`,
        });
      }
    }
  }

  // A pattern interrupt needs its sound; any first frame lands harder with one.
  if (!first.sound?.trim()) {
    if (script.hookFamily === "pattern_interrupt") {
      findings.push({ check: "hook_sound", severity: "warn", evidence: "practice", beatId: first.beatId, message: "A pattern interrupt has no sound cue. Give it a matching sound: a snap, a crack, a loud first line." });
    } else if (script.topic !== undefined) {
      findings.push({ check: "hook_sound", severity: "info", evidence: "practice", beatId: first.beatId, message: "The first frame has no sound cue. A visual hook lands harder with a matching sound." });
    }
  }

  // The call to action fits the job and the topic.
  if (script.job !== undefined) {
    const ctaBeat = script.cta ? script.beats.find((beat) => beat.beatId === script.cta?.beatId) : script.beats.find((beat) => beat.role === "cta");
    if (script.job === "convert" && !ctaBeat) {
      findings.push({ check: "cta_alignment", severity: "warn", evidence: "practice", message: "The video's job is to convert, but it has no call to action. End with one aligned to the topic, framed as a favour." });
    }
    if (script.job === "reach" && ctaBeat) {
      findings.push({ check: "cta_alignment", severity: "info", evidence: "practice", beatId: ctaBeat.beatId, message: "A reach video's call to action costs watch time. Keep it native to the topic, or drop it." });
    }
    if (script.cta && ctaBeat && script.topic !== undefined) {
      const said = `${ctaBeat.voice} ${ctaBeat.onScreenText ?? ""}`;
      if (!sharesWord(script.topic, script.cta.offer)) {
        findings.push({ check: "cta_alignment", severity: "warn", evidence: "practice", beatId: ctaBeat.beatId, message: `The call to action offers "${script.cta.offer}", which does not name the topic. Offer more of what the video was about.` });
      }
      if (script.cta.keyword && !sharesWord(script.topic, script.cta.keyword)) {
        findings.push({ check: "cta_alignment", severity: "warn", evidence: "practice", beatId: ctaBeat.beatId, message: `The keyword ${script.cta.keyword} does not match the topic. Use a keyword that names it.` });
      }
      if (script.cta.keyword && !new RegExp(`\\b${script.cta.keyword}\\b`, "i").test(said)) {
        findings.push({ check: "cta_alignment", severity: "warn", evidence: "practice", beatId: ctaBeat.beatId, message: `The keyword ${script.cta.keyword} is not said or shown in beat ${ctaBeat.beatId}.` });
      }
    }
    if (script.cta && !ctaBeat) {
      findings.push({ check: "cta_alignment", severity: "warn", evidence: "practice", message: `The call to action names beat ${script.cta.beatId}, which is not in the script.` });
    }
  }

  // A borrowed opening clip (owner decision 2026-11-04): the first beat only, planned and short, then the brand's own take at once.
  script.beats.forEach((beat, index) => {
    if (beat.borrowed && index > 0) {
      findings.push({
        check: "borrowed_clip",
        severity: "block",
        evidence: "practice",
        beatId: beat.beatId,
        message: `Beat ${beat.beatId} borrows another creator's clip. Only the opening beat may borrow; the rest of the video is the brand's own.`,
      });
    }
  });
  if (first.borrowed) {
    if (first.durationMs === undefined) {
      findings.push({ check: "borrowed_clip", severity: "block", evidence: "practice", beatId: first.beatId, message: "The borrowed clip has no planned length. Give the opening beat its durationMs." });
    } else if (first.durationMs > windows.maxBorrowedMs) {
      findings.push({
        check: "borrowed_clip",
        severity: "block",
        evidence: "sourced",
        beatId: first.beatId,
        message: `The borrowed clip runs ${seconds(first.durationMs)} s. Keep it to ${seconds(windows.maxBorrowedMs)} s, so the video stays the brand's.`,
      });
    }
    if (first.voice.trim()) {
      findings.push({ check: "borrowed_clip", severity: "warn", evidence: "practice", beatId: first.beatId, message: "The borrowed beat's sound is the other creator's. Leave its voice empty and put the brand's words in the next beat." });
    }
    const next = script.beats[1];
    if (!next || !next.voice.trim()) {
      findings.push({ check: "borrowed_clip", severity: "warn", evidence: "practice", beatId: next?.beatId, message: "Follow the borrowed clip at once with the brand's own take, in its own voice." });
    }
  } else if (script.hookFamily === "clip_stitch") {
    findings.push({
      check: "borrowed_clip",
      severity: "warn",
      evidence: "practice",
      beatId: first.beatId,
      message: "A clip-stitch hook declares its borrowed clip on the first beat: where it comes from and the credit shown.",
    });
  }

  if (!english) {
    findings.push({ check: "reading_level", severity: "info", evidence: "practice", message: `The reading-level, if-then and filler-word checks cover English only; the ${script.language} script was not checked for them.` });
  }
  return findings;
}
