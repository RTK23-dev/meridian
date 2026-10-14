// Word-level helpers for the editor (Bible 8.2 steps 3, 9 and 11): where a cut may go, where emphasis words start, and how the
// voice words group into captions. Pure. Word times are integer milliseconds from the voice track (contracts/analysis.ts).

import type { BeatSpan, Word } from "../contracts/index.ts";
import { EDIT_TUNING } from "./tuning.ts";
import { roundToFrame } from "./time.ts";

/** A window a cut may move inside: lo and hi are both allowed. */
export type Range = { lo: number; hi: number };

/** What a cut can snap to: the voice words, and the music beat period when a music track is placed. */
export type SnapContext = { words: readonly Word[]; beatPeriodMs?: number };

/** True when a time falls strictly inside a word. A cut there is the rule breach "no cut inside a word" (Bible 8.3). */
export function insideWord(words: readonly Word[], ms: number): boolean {
  return words.some((word) => word.startMs < ms && ms < word.endMs);
}

/** The midpoint of every gap between consecutive words that is at least gapMinMs long. */
export function gapMidpoints(words: readonly Word[]): number[] {
  const mids: number[] = [];
  for (let i = 0; i + 1 < words.length; i += 1) {
    const current = words[i];
    const next = words[i + 1];
    if (current === undefined || next === undefined) continue;
    if (next.startMs - current.endMs >= EDIT_TUNING.cutSnap.gapMinMs) {
      mids.push(Math.round((current.endMs + next.startMs) / 2));
    }
  }
  return mids;
}

/** The point nearest to target, ties going to the earlier point. Null when there are no points. */
function nearest(points: readonly number[], target: number): number | null {
  let best: number | null = null;
  for (const point of points) {
    if (best === null) {
      best = point;
      continue;
    }
    const distance = Math.abs(point - target);
    const bestDistance = Math.abs(best - target);
    if (distance < bestDistance || (distance === bestDistance && point < best)) best = point;
  }
  return best;
}

/**
 * Where a cut lands (Bible 8.2 step 3). The cut first moves to the nearest word gap of at least 80 ms within 250 ms. Failing
 * that, a cut inside a word moves to the nearest word edge. With music, it then moves to the nearest beat within 120 ms unless
 * the beat is inside a word. Without music it is put on the nearest frame unless that is inside a word. Always inside range.
 */
export function snapCut(target: number, range: Range, context: SnapContext): number {
  const clamped = Math.min(Math.max(target, range.lo), range.hi);
  const { words, beatPeriodMs } = context;
  const { windowMs } = EDIT_TUNING.cutSnap;
  let base = clamped;

  const gaps = gapMidpoints(words).filter((mid) => Math.abs(mid - clamped) <= windowMs && mid >= range.lo && mid <= range.hi);
  const gap = nearest(gaps, clamped);
  if (gap !== null) {
    base = gap;
  } else if (insideWord(words, clamped)) {
    const edges = words
      .flatMap((word) => [word.startMs, word.endMs])
      .filter((edge) => edge >= range.lo && edge <= range.hi && !insideWord(words, edge));
    base = nearest(edges, clamped) ?? clamped;
  }

  if (beatPeriodMs !== undefined && beatPeriodMs > 0) {
    const grid = Math.round(base / beatPeriodMs) * beatPeriodMs;
    const onBeat = Math.abs(grid - base) <= EDIT_TUNING.cutSnap.beatWindowMs && grid >= range.lo && grid <= range.hi;
    if (onBeat && !insideWord(words, grid)) base = grid;
  } else {
    const framed = roundToFrame(base);
    if (framed >= range.lo && framed <= range.hi && !insideWord(words, framed)) base = framed;
  }
  return Math.round(Math.min(Math.max(base, range.lo), range.hi));
}

/** The index of the beat that contains a time, or -1 when no beat does. */
export function beatIndexOf(beats: readonly BeatSpan[], ms: number): number {
  return beats.findIndex((beat) => beat.startMs <= ms && ms < beat.endMs);
}

/** A word or emphasis term in comparable form: lower case, letters and digits only. */
export function normalizeTerm(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Break flags for caption grouping (Bible 8.2 step 9). breaks[j] is true when a caption may end after word j: at the end of the
 * video, after punctuation, or where the next word starts a new beat.
 */
export function captionBreaks(words: readonly Word[], beats: readonly BeatSpan[]): boolean[] {
  return words.map((word, index) => {
    if (index === words.length - 1) return true;
    if (EDIT_TUNING.captions.breakPattern.test(word.text)) return true;
    const next = words[index + 1];
    return next !== undefined && beatIndexOf(beats, word.startMs) !== beatIndexOf(beats, next.startMs);
  });
}

/**
 * Splits the words into captions of min to max words (Bible 8.2 step 9). The split is the least costly one: a caption ends on a
 * break for free and elsewhere at a cost of 1, and a size far from the middle of the range costs a little. Ties resolve the same
 * way every time. Returns the [first, end) word index of each caption, or null when no split fits the range.
 */
export function groupWords(breaks: readonly boolean[], range: { min: number; max: number }): Array<[number, number]> | null {
  const count = breaks.length;
  if (count === 0) return [];
  const { min, max } = range;
  if (min < 1 || max < min || count < min) return null;
  const middle = (min + max) / 2;

  const best: number[] = new Array<number>(count + 1).fill(Number.POSITIVE_INFINITY);
  const from: number[] = new Array<number>(count + 1).fill(-1);
  best[0] = 0;
  for (let end = 1; end <= count; end += 1) {
    for (let size = min; size <= max; size += 1) {
      const start = end - size;
      if (start < 0) break;
      const previous = best[start];
      if (previous === undefined || previous === Number.POSITIVE_INFINITY) continue;
      const cost = previous + (breaks[end - 1] ? 0 : 1) + 0.01 * Math.abs(size - middle);
      const current = best[end];
      if (current !== undefined && cost < current - 1e-9) {
        best[end] = cost;
        from[end] = start;
      }
    }
  }
  if (best[count] === Number.POSITIVE_INFINITY) return null;

  const captions: Array<[number, number]> = [];
  let end = count;
  while (end > 0) {
    const start = from[end];
    if (start === undefined || start < 0) return null;
    captions.unshift([start, end]);
    end = start;
  }
  return captions;
}

/**
 * The start of every emphasis word (Bible 8.2 step 10 and 6). A mark names the beat and the term; the matching words are the words
 * of that beat whose normalised text is one of the term's normalised tokens. Sorted, without duplicates.
 */
export function emphasisStarts(words: readonly Word[], beats: readonly BeatSpan[], marks: readonly { beatId: string; term: string }[]): number[] {
  const starts = new Set<number>();
  for (const mark of marks) {
    const tokens = new Set(mark.term.split(/\s+/).map(normalizeTerm).filter((token) => token.length > 0));
    if (tokens.size === 0) continue;
    for (const word of words) {
      const beat = beats[beatIndexOf(beats, word.startMs)];
      if (beat === undefined || beat.beatId !== mark.beatId) continue;
      if (tokens.has(normalizeTerm(word.text))) starts.add(word.startMs);
    }
  }
  return [...starts].sort((a, b) => a - b);
}
