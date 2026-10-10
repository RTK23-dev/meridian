/**
 * Price model (P4b). A price is one of four states, and only two of them can produce an estimate:
 *
 * - verified: confirmed against an official price source on `verifiedAt`.
 * - configured: declared by the owner in provider configuration. It is not checked against a price page.
 * - unknown: no price is known. Nothing is invented, so there is no estimate and the cost is not known.
 * - stale: a price was once known but is no longer current. Its amount is kept for display only, never estimated from.
 *
 * A missing or stale price is never treated as zero. A zero is a real price only when the provider declares it
 * (manual cloud is a zero-spend workflow, and that is declared, not inferred).
 */

export type PriceStatus = "verified" | "configured" | "unknown" | "stale";

export type PriceUnit = "per_second" | "per_image";

export interface PriceQuote {
  status: PriceStatus;
  unit: PriceUnit;
  /** The declared amount in USD, or null when there is none. */
  amountUsd: number | null;
  /** Where the amount came from. Never a guess. */
  source: string;
  /** When an official price was verified. Null unless `status` is verified. */
  verifiedAt: string | null;
}

export interface CostEstimate {
  /** True only when the price is current and its unit matches what is billed. */
  costKnown: boolean;
  costStatus: PriceStatus;
  /** Null unless `costKnown`. Never zero for an unknown or stale price. */
  estimateUsd: number | null;
}

export function unknownQuote(unit: PriceUnit, source: string): PriceQuote {
  return { status: "unknown", unit, amountUsd: null, source, verifiedAt: null };
}

/** A price the owner declared in provider configuration. Configured, not verified against a price page. */
export function configuredQuote(unit: PriceUnit, amountUsd: number, source: string): PriceQuote {
  return { status: "configured", unit, amountUsd, source, verifiedAt: null };
}

function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * The estimate for `units` of work at this price. A price in another unit, a stale or unknown price, a price with no
 * amount, and a "verified" price with no date all yield no estimate: the cost is not known.
 */
export function estimateCost(quote: PriceQuote, units: number, billedUnit: PriceUnit): CostEstimate {
  const unknown = (costStatus: PriceStatus): CostEstimate => ({ costKnown: false, costStatus, estimateUsd: null });
  if (quote.unit !== billedUnit) return unknown("unknown");
  if (quote.status === "stale") return unknown("stale");
  if (quote.status === "unknown") return unknown("unknown");
  if (quote.amountUsd === null || !Number.isFinite(quote.amountUsd)) return unknown("unknown");
  if (quote.status === "verified" && quote.verifiedAt === null) return unknown("unknown");
  return { costKnown: true, costStatus: quote.status, estimateUsd: roundUsd(units * quote.amountUsd) };
}
