// Copy checks (Bible 1 principle 4; CLAUDE.md rule 8). Genes transfer, content does not: the words of the example may enter a
// stored field only as measurements or as the transcript used for segmentation. A label that repeats COPY_RUN_WORDS words of
// the transcript, in order, is copied content. The roles and the stage both use this check, so a model answer that copies is
// refused by the role (and retried once), and a stored field is checked again before the DNA is written.

/** Words in a row from the transcript that make a label copied content. Initial value. */
export const COPY_RUN_WORDS = 3;

/** Lower-case word tokens: letters, digits and apostrophes. Punctuation and spacing are not words. */
export function wordTokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .trim()
    .split(" ")
    .filter((token) => token.length > 0);
}

/** Every run of `size` consecutive tokens, joined with a space. */
function runsOf(tokens: readonly string[], size: number): Set<string> {
  const runs = new Set<string>();
  for (let start = 0; start + size <= tokens.length; start++) {
    runs.add(tokens.slice(start, start + size).join(" "));
  }
  return runs;
}

/**
 * True when the text repeats a run of COPY_RUN_WORDS words that the transcript says in the same order. A text with fewer
 * words than the run length cannot copy anything, so it passes.
 */
export function copiesTranscript(
  text: string,
  transcript: ReadonlyArray<{ text: string }>,
  size: number = COPY_RUN_WORDS,
): boolean {
  const spoken = runsOf(
    transcript.flatMap((word) => wordTokens(word.text)),
    size,
  );
  if (spoken.size === 0) return false;
  for (const run of runsOf(wordTokens(text), size)) {
    if (spoken.has(run)) return true;
  }
  return false;
}
