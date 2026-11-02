export type StageCost = {
  stage: string;
  cents: number;
  seconds: number;
};

export type FactoryCostRollup = {
  decodedAds: number;
  variants: number;
  winningVariants: number;
  costPerDecodedAdCents: number | null;
  costPerVariantCents: number | null;
  costPerWinningVariantCents: number | null;
  totalCents: number;
};

export function rollupCosts(input: {
  stages: StageCost[];
  decodedAds: number;
  variants: number;
  winningVariants: number;
}): FactoryCostRollup {
  const totalCents = input.stages.reduce((sum, row) => sum + Math.max(0, row.cents), 0);
  const per = (count: number) => (count <= 0 ? null : Math.round(totalCents / count));
  return {
    decodedAds: input.decodedAds,
    variants: input.variants,
    winningVariants: input.winningVariants,
    costPerDecodedAdCents: per(input.decodedAds),
    costPerVariantCents: per(input.variants),
    costPerWinningVariantCents: per(input.winningVariants),
    totalCents,
  };
}

/**
 * Each stage's priced total, from the cost rows (B12, Q27). A row with no price has no cents: it is counted as unpriced, never as zero, and a
 * stage with no priced row is left out of the stages. The seconds count every row that has them.
 */
export function stageRollupOf(rows: ReadonlyArray<{ stage: string; cents: number | null; seconds: number }>): {
  stages: StageCost[];
  unpricedRows: number;
} {
  const byStage = new Map<string, StageCost>();
  let unpricedRows = 0;
  for (const row of rows) {
    if (row.cents === null || !Number.isFinite(row.cents)) {
      unpricedRows += 1;
      continue;
    }
    const current = byStage.get(row.stage) ?? { stage: row.stage, cents: 0, seconds: 0 };
    current.cents += row.cents;
    current.seconds += Number.isFinite(row.seconds) ? row.seconds : 0;
    byStage.set(row.stage, current);
  }
  return { stages: [...byStage.values()].sort((a, b) => a.stage.localeCompare(b.stage)), unpricedRows };
}

export function withinBudget(spentCents: number, budgetCents: number): boolean {
  if (budgetCents < 0) return false;
  return spentCents <= budgetCents;
}
