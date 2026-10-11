/**
 * Pure rules for the usage and cost screen. A cost the server could not total is null, and it stays unknown here. It is
 * never shown as zero, and no bar is drawn from a number that is missing.
 */

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/**
 * Cost in cents as dollars, the same convention as the factory cost view. A null, missing or non-finite cost is
 * "Cost unknown", never "$0.00".
 */
export function formatCostCents(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "Cost unknown";
  return USD.format(cents / 100);
}

/**
 * Width of a bar as a share of the largest value on screen. Null when the value or the maximum is unknown, or when the
 * maximum is zero, so no bar is drawn from a guess.
 */
export function barPercent(value: number | null | undefined, max: number | null | undefined): number | null {
  if (value == null || max == null || !Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return null;
  return Math.min(100, Math.max(0, (value / max) * 100));
}

/** Token totals are a lower bound when some runs recorded no token count. The label says so. */
export function tokensLabel(tokens: number, missingTokens: number): string {
  const shown = tokens.toLocaleString();
  return missingTokens > 0 ? `${shown} (at least)` : shown;
}

/** Shown under a cost total that includes runs with no recorded cost. Null when every run has a cost. */
export function costNote(missingCost: number): string | null {
  if (missingCost <= 0) return null;
  return `${missingCost.toLocaleString()} run${missingCost === 1 ? " has" : "s have"} no recorded cost, so this total is unknown.`;
}

export function truncationNote(truncated: boolean, rowLimit: number): string | null {
  return truncated ? `Totals cover the newest ${rowLimit.toLocaleString()} runs. Older runs are not counted.` : null;
}

/** A UTC calendar day from the server (YYYY-MM-DD). An empty value is shown as unknown. */
export function dayLabel(day: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "Unknown day";
}
