export type UsageRun = {
  operation: string;
  tokens: number | null;
  costCents: number | null;
};

/** Token totals are summed. Cost stays null unless every run reported a cost. */
export function summarizeUsage(runs: UsageRun[]): {
  tokens: number;
  byOperation: { operation: string; tokens: number }[];
  costCents: number | null;
  missingCost: number;
} {
  const totals = new Map<string, number>();
  let tokens = 0;
  let knownCost = 0;
  let missingCost = 0;
  for (const run of runs) {
    const count = run.tokens ?? 0;
    tokens += count;
    totals.set(run.operation, (totals.get(run.operation) ?? 0) + count);
    if (run.costCents == null) missingCost += 1;
    else knownCost += run.costCents;
  }
  return {
    tokens,
    byOperation: [...totals.entries()].map(([operation, amount]) => ({ operation, tokens: amount })),
    costCents: runs.length > 0 && missingCost === 0 ? knownCost : null,
    missingCost,
  };
}

export type UsageGroup = {
  key: string;
  runs: number;
  tokens: number;
  /** Null when any run in the group has no recorded cost. An unknown cost is never shown as 0. */
  costCents: number | null;
  missingCost: number;
  /** Runs with no token count. Their tokens are not in `tokens`, so `tokens` is a lower bound when this is above 0. */
  missingTokens: number;
};

/** Groups runs by a key and applies summarizeUsage to each group, so cost rules are the same at every level. */
export function groupUsage<T extends UsageRun>(runs: readonly T[], keyOf: (run: T) => string): UsageGroup[] {
  const groups = new Map<string, T[]>();
  for (const run of runs) {
    const key = keyOf(run);
    const bucket = groups.get(key);
    if (bucket) bucket.push(run);
    else groups.set(key, [run]);
  }
  return [...groups.entries()].map(([key, members]) => {
    const summary = summarizeUsage(members);
    return {
      key,
      runs: members.length,
      tokens: summary.tokens,
      costCents: summary.costCents,
      missingCost: summary.missingCost,
      missingTokens: members.filter((run) => run.tokens == null).length,
    };
  });
}
