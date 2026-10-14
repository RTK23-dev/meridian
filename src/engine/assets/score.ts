// Provider scoring (Bible 10.2). Pure: values in, numbers out. Weights come from config/weights.ts.
//
// How unknowns are scored: a dimension whose value is unknown (no pass rate, no gold-set score, too few attempts, no
// price difference to compare) is LEFT OUT of that candidate's weighted mean. It is neither 0 nor 1 and it earns no credit
// and no penalty. The score is the mean over the known dimensions only. Ranking therefore uses coverage as a tie-break: when
// two candidates have the same score, the one with more known dimensions ranks first, and then the route's priority order.
// Every Decision names the unknown dimensions, so a choice made on little evidence is visible.

import { weights } from "../config/weights.ts";

export const PROVIDER_DIMENSIONS = [
  "taskFit",
  "outputQuality",
  "control",
  "reliability",
  "costEfficiency",
  "latency",
  "continuity",
] as const;

export type ProviderDimension = (typeof PROVIDER_DIMENSIONS)[number];

/** A dimension value in [0, 1], or null (or absent) when it is unknown. */
export type DimensionValues = Partial<Record<ProviderDimension, number | null>>;

export type DimensionWeights = Record<ProviderDimension, number>;

export function configuredWeights(): DimensionWeights {
  const score = weights.providerScore;
  return {
    taskFit: score.taskFit.value,
    outputQuality: score.outputQuality.value,
    control: score.control.value,
    reliability: score.reliability.value,
    costEfficiency: score.costEfficiency.value,
    latency: score.latency.value,
    continuity: score.continuity.value,
  };
}

export type ScoreResult = {
  /** Weighted mean over the known dimensions, or null when none is known. */
  score: number | null;
  known: ProviderDimension[];
  unknown: ProviderDimension[];
  /** Share of the total weight that is known, from 0 to 1. */
  coverage: number;
};

function isKnown(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function scoreProvider(values: DimensionValues, dimensionWeights: DimensionWeights): ScoreResult {
  const known: ProviderDimension[] = [];
  const unknown: ProviderDimension[] = [];
  let weightedSum = 0;
  let knownWeight = 0;
  let totalWeight = 0;
  for (const dimension of PROVIDER_DIMENSIONS) {
    const weight = dimensionWeights[dimension];
    totalWeight += weight;
    const value = values[dimension];
    if (isKnown(value)) {
      known.push(dimension);
      weightedSum += weight * value;
      knownWeight += weight;
    } else {
      unknown.push(dimension);
    }
  }
  return {
    score: knownWeight > 0 ? weightedSum / knownWeight : null,
    known,
    unknown,
    coverage: totalWeight > 0 ? knownWeight / totalWeight : 0,
  };
}

/**
 * Cost efficiency (Bible 10.2): 1 minus the price over the most expensive eligible price. When every eligible price is the
 * same, or there is only one, nothing is compared, so every value is unknown rather than 0.
 */
export function costEfficiencyValues(prices: ReadonlyArray<{ id: string; usd: number }>): Map<string, number | null> {
  const values = new Map<string, number | null>();
  const highest = Math.max(...prices.map((price) => price.usd));
  const lowest = Math.min(...prices.map((price) => price.usd));
  for (const price of prices) {
    values.set(price.id, prices.length < 2 || highest <= lowest ? null : 1 - price.usd / highest);
  }
  return values;
}

/**
 * Latency (Bible 10.2): the fastest median over this candidate's median, capped at 1. It needs at least two candidates with
 * a measured median, because one measurement says nothing about the others.
 */
export function latencyValues(medians: ReadonlyArray<{ id: string; ms: number | null }>): Map<string, number | null> {
  const measured = medians.filter((entry): entry is { id: string; ms: number } => entry.ms !== null);
  const values = new Map<string, number | null>();
  const fastest = measured.length >= 2 ? Math.max(1, Math.min(...measured.map((entry) => entry.ms))) : null;
  for (const entry of medians) {
    values.set(entry.id, fastest === null || entry.ms === null ? null : Math.min(1, fastest / Math.max(1, entry.ms)));
  }
  return values;
}

/**
 * Control (Bible 10.2): the share of the three steering features an adapter declares (first frame, last frame, references).
 * It comes from the adapter's capabilities, so it is always known for an adapter that is eligible. The seed is not declared
 * by ProviderCapabilities and is not counted.
 */
export function controlValue(capabilities: { firstFrame: boolean; lastFrame: boolean; refsMax: number }): number {
  return ((capabilities.firstFrame ? 1 : 0) + (capabilities.lastFrame ? 1 : 0) + (capabilities.refsMax > 0 ? 1 : 0)) / 3;
}

/** Continuity (Bible 10.2): 1 for the provider the scene's earlier shots used, 0 for another, unknown when there is none. */
export function continuityValue(providerId: string, earlierProviderId: string | null | undefined): number | null {
  if (earlierProviderId === null || earlierProviderId === undefined) return null;
  return providerId === earlierProviderId ? 1 : 0;
}

/** Ranking: higher score first, unknown scores last, then more coverage, then the route's priority order. */
export function compareScored(
  a: { score: ScoreResult; priority: number },
  b: { score: ScoreResult; priority: number },
): number {
  const aScore = a.score.score;
  const bScore = b.score.score;
  if (aScore !== null && bScore !== null && aScore !== bScore) return bScore - aScore;
  if (aScore !== null && bScore === null) return -1;
  if (aScore === null && bScore !== null) return 1;
  if (a.score.coverage !== b.score.coverage) return b.score.coverage - a.score.coverage;
  return a.priority - b.priority;
}
