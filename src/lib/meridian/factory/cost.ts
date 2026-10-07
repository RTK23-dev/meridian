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

export function withinBudget(spentCents: number, budgetCents: number): boolean {
  if (budgetCents < 0) return false;
  return spentCents <= budgetCents;
}
