// Percentiles and rates for the operations metrics (Video Engine Bible 15.3). Pure functions, no I/O. An empty sample has no
// percentile and an empty denominator has no rate: both are null, never 0 (Bible 0, rule 1: unknown stays null).

import { EngineError } from "../contracts/index.ts";

export type Distribution = { count: number; p50: number | null; p95: number | null };

/**
 * Nearest-rank percentile: the value at rank ceil(p / 100 x n) of the sorted sample, for p over 0 and up to 100. Values that are
 * not finite numbers are not samples. An empty sample returns null.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (!Number.isFinite(p) || p <= 0 || p > 100) {
    throw new EngineError("invalid_input", "a percentile is a number over 0 and up to 100");
  }
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] ?? null;
}

/** The sample size and the 50th and 95th percentiles of a sample. */
export function distributionOf(values: readonly number[]): Distribution {
  return { count: values.filter((value) => Number.isFinite(value)).length, p50: percentile(values, 50), p95: percentile(values, 95) };
}

/** part / whole, rounded to four decimals, or null when there is nothing to divide by. */
export function rateOf(part: number, whole: number): number | null {
  if (!(whole > 0)) return null;
  return Math.round((part / whole) * 10_000) / 10_000;
}
