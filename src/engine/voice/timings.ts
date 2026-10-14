// The beat spans of a voice track (Bible 6.3, the test "beat spans cover the full duration without gaps"). A beat starts at the
// start of the first word the speech said for it, the first beat starts at zero, and each beat ends where the next one starts;
// the last beat ends at the end of the audio. So the spans cover the duration with no gap and no overlap, by construction, and
// a beat whose first word was not said has no start: that is a problem, reported, never guessed. Pure.

import type { Word } from "../contracts/analysis.ts";
import type { Alignment } from "./align.ts";

export type BeatSpan = { beatId: string; startMs: number; endMs: number };

export type BeatSpans = { spans: BeatSpan[]; problems: string[] };

/**
 * The spans of the beats. `tokenCounts` is the number of script words in each beat; `heardWordOfToken` maps a script word
 * index to the index of the heard word (in `words`) that the alignment paired it with. A missing pairing is a problem.
 */
export function beatSpansOf(input: {
  beatIds: readonly string[];
  tokenCounts: readonly number[];
  alignment: Alignment;
  heardTokenWord: readonly number[];
  words: readonly Word[];
  durationMs: number;
}): BeatSpans {
  const problems: string[] = [];
  const wordOfScript = new Map<number, number>();
  for (const pair of input.alignment.pairs) {
    const wordIndex = input.heardTokenWord[pair.heardIndex];
    if (wordIndex !== undefined) wordOfScript.set(pair.scriptIndex, wordIndex);
  }
  const starts: Array<number | null> = [];
  let firstToken = 0;
  input.beatIds.forEach((beatId, beat) => {
    const count = input.tokenCounts[beat] ?? 0;
    if (count === 0) {
      problems.push(`beat ${beatId} has no spoken words`);
      starts.push(null);
    } else if (beat === 0) {
      starts.push(0);
    } else {
      const wordIndex = wordOfScript.get(firstToken);
      const word = wordIndex === undefined ? undefined : input.words[wordIndex];
      if (word === undefined) {
        problems.push(`the first word of beat ${beatId} was not said`);
        starts.push(null);
      } else {
        starts.push(word.startMs);
      }
    }
    firstToken += count;
  });

  const spans: BeatSpan[] = [];
  input.beatIds.forEach((beatId, beat) => {
    const startMs = starts[beat] ?? null;
    const nextStart =
      beat + 1 < input.beatIds.length ? (starts[beat + 1] ?? null) : input.durationMs;
    if (startMs === null || nextStart === null) return;
    if (nextStart <= startMs) {
      problems.push(`beat ${beatId} has an empty span (${startMs} to ${nextStart} ms)`);
      return;
    }
    spans.push({ beatId, startMs, endMs: nextStart });
  });
  return { spans, problems };
}
