// Aligns the script's words with the words the speech-to-text heard (Bible 6.3 step 3, the 3% word error rule). A minimum-edit
// alignment with unit costs for a substitution, a deletion and an insertion. Pure. Each script word is paired with the heard
// word at the same place in the sequence, or is reported as deleted (the speech did not say it). The word error rate is the
// edits over the script's words. An empty script has no rate, so it is reported as 1 (a failure), never as 0.

export type AlignedPair = { scriptIndex: number; heardIndex: number };

export type Alignment = {
  /** Script words paired with a heard word (matched or substituted), in order. */
  pairs: AlignedPair[];
  /** Script words the speech did not say. */
  deletedScript: number[];
  /** Heard words that are not in the script. */
  insertedHeard: number[];
  substitutions: number;
  /** (substitutions + deletions + insertions) / script words. 1 when the script has no words. */
  wordErrorRate: number;
};

/** The minimum-edit alignment of two token sequences (unit costs), with a backtrace that prefers matches. */
export function alignTokens(script: readonly string[], heard: readonly string[]): Alignment {
  const n = script.length;
  const m = heard.length;
  const cost: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 0; i <= n; i++) cost[i]![0] = i;
  for (let j = 0; j <= m; j++) cost[0]![j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const same = script[i - 1] === heard[j - 1] ? 0 : 1;
      cost[i]![j] = Math.min(
        (cost[i - 1]![j - 1] ?? 0) + same,
        (cost[i - 1]![j] ?? 0) + 1,
        (cost[i]![j - 1] ?? 0) + 1,
      );
    }
  }

  const pairs: AlignedPair[] = [];
  const deletedScript: number[] = [];
  const insertedHeard: number[] = [];
  let substitutions = 0;
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const here = cost[i]![j] ?? 0;
    if (
      i > 0 &&
      j > 0 &&
      here === (cost[i - 1]![j - 1] ?? 0) + (script[i - 1] === heard[j - 1] ? 0 : 1)
    ) {
      pairs.push({ scriptIndex: i - 1, heardIndex: j - 1 });
      if (script[i - 1] !== heard[j - 1]) substitutions += 1;
      i -= 1;
      j -= 1;
    } else if (i > 0 && here === (cost[i - 1]![j] ?? 0) + 1) {
      deletedScript.push(i - 1);
      i -= 1;
    } else {
      insertedHeard.push(j - 1);
      j -= 1;
    }
  }
  pairs.reverse();
  deletedScript.reverse();
  insertedHeard.reverse();

  const edits = cost[n]![m] ?? 0;
  return {
    pairs,
    deletedScript,
    insertedHeard,
    substitutions,
    wordErrorRate: n === 0 ? 1 : edits / n,
  };
}
