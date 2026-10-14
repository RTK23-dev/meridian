// The narration text and its pacing marks (Bible 6.3 step 1). The speech route takes plain text (PROVIDER_APIS.md), so the
// marks are not sent as markup. Each beat becomes one sentence group, closed by a full stop when it does not end on punctuation,
// and the marks record where each beat and each emphasis word sits in that text. The marks are data for the pacing checks and
// for the stored track, never an instruction to the vendor. Pure.

import { wordTokens } from "../analyze/copy.ts";
import type { ScriptBeat } from "../contracts/request.ts";

export type EmphasisMark = { word: string; startChar: number; endChar: number };

export type PacingMark = {
  beatId: string;
  startChar: number;
  endChar: number;
  emphasis: EmphasisMark[];
};

export type VoiceText = { text: string; marks: PacingMark[] };

const ENDS_A_SENTENCE = /[.!?…]["')\]]?$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Each emphasis word, found in the beat's text as a whole word, ignoring case. Its offsets are inside the beat. */
function emphasisIn(text: string, emphasis: readonly string[] | undefined): EmphasisMark[] {
  const marks: EmphasisMark[] = [];
  for (const word of new Set(
    (emphasis ?? []).map((item) => item.trim()).filter((item) => item.length > 0),
  )) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{N}])`, "giu");
    for (const match of text.matchAll(pattern)) {
      const startChar = match.index ?? 0;
      marks.push({ word: match[0], startChar, endChar: startChar + match[0].length });
    }
  }
  return marks.sort((a, b) => a.startChar - b.startChar);
}

/**
 * The narration text of the beats, in order, with the offsets of each beat and emphasis word. A beat's text is trimmed; a beat
 * that does not end on a sentence stop gets a full stop, so the speech pauses at every beat boundary.
 */
export function buildVoiceText(beats: readonly ScriptBeat[]): VoiceText {
  let text = "";
  const marks: PacingMark[] = [];
  beats.forEach((beat, index) => {
    const body = beat.text.trim();
    const sentence = ENDS_A_SENTENCE.test(body) ? body : `${body}.`;
    const startChar = text.length;
    const emphasis = emphasisIn(sentence, beat.emphasis).map((mark) => ({
      word: mark.word,
      startChar: startChar + mark.startChar,
      endChar: startChar + mark.endChar,
    }));
    marks.push({ beatId: beat.beatId, startChar, endChar: startChar + sentence.length, emphasis });
    text += sentence;
    if (index < beats.length - 1) text += " ";
  });
  return { text, marks };
}

/** The script's word tokens, with the beat each one belongs to, in order. Used to align the script with the transcript. */
export function scriptTokens(beats: readonly ScriptBeat[]): {
  tokens: string[];
  perBeat: number[];
} {
  const perBeat = beats.map((beat) => wordTokens(beat.text).length);
  return { tokens: beats.flatMap((beat) => wordTokens(beat.text)), perBeat };
}
