// US dollars as numbers with 4 decimals (Bible section 4, shared conventions).
// Sums are done in integer ten-thousandths so that totals do not drift.

import { z } from "zod";
import { EngineError } from "./errors.ts";

const MICRO_PER_USD = 10000;

function hasAtMostFourDecimals(value: number): boolean {
  const scaled = value * MICRO_PER_USD;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

export const usdSchema = z
  .number()
  .finite()
  .nonnegative()
  .refine(hasAtMostFourDecimals, { message: "USD amounts carry at most 4 decimals" });

export type Usd = z.infer<typeof usdSchema>;

/** Round a computed USD amount to 4 decimals. Negative, NaN or infinite amounts are refused. */
export function roundUsd(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new EngineError("invalid_input", `USD amount must be finite and >= 0, got ${String(value)}`);
  }
  return Math.round(value * MICRO_PER_USD) / MICRO_PER_USD;
}

/** Exact sum of USD amounts, rounded to 4 decimals. */
export function sumUsd(values: readonly number[]): number {
  let units = 0;
  for (const value of values) {
    units += Math.round(roundUsd(value) * MICRO_PER_USD);
  }
  return units / MICRO_PER_USD;
}
