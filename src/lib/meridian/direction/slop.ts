// The slop lexicon (framework 11, weak spots W4 and W13, and section 7 on bait). It finds the phrases and patterns that mark a script as
// machine-written, stock, or bait, in the voice lines and the on-screen text of a directed script. Each finding names its check, its
// severity and the beat it is in, so a writer can fix the line.
//
// English only: the lists are English phrases. A script in another language is not checked, and the report says so (an unknown result
// is never a pass). Matching is on whole words, case-insensitive, with curly quotes made straight. Pure.

import type { CheckId, EvidenceLabel } from "./codex.ts";
import type { DirectedBeat } from "./script.ts";

export type Severity = "block" | "warn" | "info";

/** One thing a check found. `beatId` is absent for a finding about the whole script. */
export type ScriptFinding = {
  check: CheckId;
  severity: Severity;
  message: string;
  evidence: EvidenceLabel;
  beatId?: string;
  phrase?: string;
};

type LexiconEntry = { check: CheckId; severity: Severity; evidence: EvidenceLabel; reason: string; phrases: readonly string[] };

/** Openers that delay the hook. Refused in the first beat, warned elsewhere. */
export const PREAMBLE: LexiconEntry = {
  check: "preamble",
  severity: "block",
  evidence: "sourced",
  reason: "delays the hook; the platforms advise against intros",
  phrases: [
    "hey guys",
    "hi guys",
    "hi everyone",
    "hello everyone",
    "welcome back",
    "in this video",
    "in today's video",
    "today we're going to",
    "today i'm going to",
    "today i want to",
    "let's dive in",
    "let's get started",
    "let's get into it",
    "without further ado",
    "before we begin",
    "before we start",
    "have you ever wondered",
  ],
};

/** End cards in words. Refused: the end is a punch or a seam (framework 6). */
export const OUTRO: LexiconEntry = {
  check: "outro",
  severity: "block",
  evidence: "practice",
  reason: "an outro ends the video on a decline",
  phrases: [
    "thanks for watching",
    "thank you for watching",
    "don't forget to like",
    "like and subscribe",
    "follow for more",
    "see you in the next",
    "see you next time",
    "that's all for today",
    "hit the bell",
    "until next time",
  ],
};

/** Requests for engagement in exchange for nothing. Refused (framework 7; Meta demotes engagement bait, including in video audio). */
export const ENGAGEMENT_BAIT: LexiconEntry = {
  check: "engagement_bait",
  severity: "block",
  evidence: "sourced",
  reason: "engagement bait can limit distribution and spends the viewer's trust",
  phrases: [
    "comment yes",
    "comment below if",
    "like if you",
    "like this if",
    "share if you",
    "share this with",
    "tag a friend",
    "tag someone",
    "tag your friend",
    "type yes",
    "type 1 if",
    "double tap if",
    "smash that like",
    "vote with",
  ],
};

/** Hooks and lines every viewer has heard. Warned: they read as stock, and they are what a model reaches for first (W13). */
export const STOCK_HOOKS: LexiconEntry = {
  check: "stock_hook",
  severity: "warn",
  evidence: "practice",
  reason: "a stock line the viewer has heard before",
  phrases: [
    "you won't believe",
    "you'll never guess",
    "this will blow your mind",
    "blow your mind",
    "wait for it",
    "watch till the end",
    "watch until the end",
    "wait until the end",
    "nobody is talking about",
    "no one is talking about",
    "this changes everything",
    "this changed everything",
    "here's the thing",
    "let me explain",
    "stop scrolling",
    "you need to see this",
    "will shock you",
    "what happens next",
    "this is your sign",
    "trust me",
    "life hack",
    "the secret to",
  ],
};

/** The AI register (W4): words and phrases whose use rose with language models, and marketing filler they reach for. Warned. */
export const AI_REGISTER: LexiconEntry = {
  check: "slop_lexicon",
  severity: "warn",
  evidence: "sourced",
  reason: "reads as machine-written",
  phrases: [
    "delve",
    "delves",
    "delving",
    "tapestry",
    "testament to",
    "the realm of",
    "in the realm",
    "the landscape of",
    "navigate the",
    "navigating the",
    "unlock",
    "unlocks",
    "unlocking",
    "unleash",
    "elevate",
    "elevates",
    "empower",
    "empowers",
    "seamless",
    "seamlessly",
    "robust",
    "leverage",
    "game-changer",
    "game changer",
    "revolutionize",
    "revolutionise",
    "cutting-edge",
    "cutting edge",
    "fast-paced world",
    "in today's digital age",
    "ever-evolving",
    "ever-changing",
    "embark",
    "it's important to note",
    "it's worth noting",
    "furthermore",
    "moreover",
    "in conclusion",
    "whether you're a",
    "look no further",
    "to the next level",
    "supercharge",
    "harness the power",
    "the power of",
    "dive into",
    "deep dive",
    "crucial",
    "pivotal",
    "intricate",
    "showcasing",
    "underscores",
    "foster",
    "bustling",
    "vibrant",
    "nestled",
    "meticulous",
    "meticulously",
    "comprehensive",
    "holistic",
    "synergy",
    "paradigm",
    "transformative",
    "plethora",
    "myriad",
    "a symphony of",
    "let that sink in",
    "here's the kicker",
    "buckle up",
  ],
};

export const LEXICON: readonly LexiconEntry[] = [PREAMBLE, OUTRO, ENGAGEMENT_BAIT, STOCK_HOOKS, AI_REGISTER];

/** "It's not X, it's Y" and "This isn't about X. It's about Y.": the model's favourite turn (W4). */
const NOT_X_BUT_Y =
  /\b(?:(?:it|this|that)(?:'s| is)\s+not|(?:it|this|that)\s+isn't)\s+(?:just\s+|only\s+|about\s+)?[^.!?;]{1,60}?[,;:.\u2014\u2013-]+\s*(?:it|this|that)(?:'s| is)\b/i;

/** Dashes that a voice line does not need: an em dash or an en dash. */
const DASH = /[\u2014\u2013]/g;

/** Text with curly quotes made straight and spacing reduced, so phrases match however they were typed. */
export function normalizeText(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201F\u2033]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function phrasePattern(phrase: string): RegExp {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}'])${escaped}(?![\\p{L}\\p{N}])`, "iu");
}

const PATTERNS = new Map<string, RegExp>();
function patternOf(phrase: string): RegExp {
  let pattern = PATTERNS.get(phrase);
  if (!pattern) {
    pattern = phrasePattern(phrase);
    PATTERNS.set(phrase, pattern);
  }
  return pattern;
}

/** The lexicon phrases a text contains, each with its entry. */
export function lexiconHits(text: string): { entry: LexiconEntry; phrase: string }[] {
  const normalized = normalizeText(text);
  const hits: { entry: LexiconEntry; phrase: string }[] = [];
  for (const entry of LEXICON) {
    for (const phrase of entry.phrases) {
      if (patternOf(phrase).test(normalized)) hits.push({ entry, phrase });
    }
  }
  return hits;
}

/** True when the language tag is English (en, en-GB, and so on). */
export function isEnglish(language: string): boolean {
  return /^en(?:-|$)/i.test(language.trim());
}

function words(text: string): number {
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)?.length ?? 0;
}

/**
 * The slop findings of a script's beats. The first beat's preamble is refused; a preamble phrase later is a warning. A phrase found in
 * both a beat's voice and its on-screen text is reported once.
 */
export function slopFindings(beats: readonly DirectedBeat[], language: string): ScriptFinding[] {
  if (!isEnglish(language)) {
    return [
      {
        check: "slop_lexicon",
        severity: "info",
        evidence: "practice",
        message: `The slop lexicon covers English only; the ${language} script was not checked for it.`,
      },
    ];
  }

  const findings: ScriptFinding[] = [];
  beats.forEach((beat, index) => {
    const lines = [beat.voice, beat.onScreenText ?? ""].filter((line) => line.trim().length > 0);
    const seen = new Set<string>();
    for (const line of lines) {
      for (const { entry, phrase } of lexiconHits(line)) {
        const key = `${entry.check}:${phrase}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const severity: Severity = entry === PREAMBLE && index > 0 ? "warn" : entry.severity;
        findings.push({
          check: entry.check,
          severity,
          evidence: entry.evidence,
          beatId: beat.beatId,
          phrase,
          message: `Beat ${beat.beatId} says "${phrase}": ${entry.reason}.`,
        });
      }
      if (!seen.has("not_x_but_y") && NOT_X_BUT_Y.test(normalizeText(line))) {
        seen.add("not_x_but_y");
        findings.push({
          check: "not_x_but_y",
          severity: "warn",
          evidence: "practice",
          beatId: beat.beatId,
          message: `Beat ${beat.beatId} uses the "it's not X, it's Y" turn, a machine-writing tic. Say the second half plainly.`,
        });
      }
    }
  });

  const voiceText = beats.map((beat) => beat.voice).join(" ");
  const dashes = voiceText.match(DASH)?.length ?? 0;
  const allowed = Math.max(1, Math.floor(words(voiceText) / 60));
  if (dashes > allowed) {
    findings.push({
      check: "dash_density",
      severity: "warn",
      evidence: "practice",
      message: `The voice lines use ${dashes} long dashes. A voice does not speak dashes: use a full stop or a pause.`,
    });
  }
  return findings;
}
