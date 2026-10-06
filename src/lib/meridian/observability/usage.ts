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
