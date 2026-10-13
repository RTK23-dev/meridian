/**
 * A stored metric is its value or null. A source that reports no value leaves the column null, and a null never reads as a
 * measured zero. A stored zero is a measured zero and stays zero.
 */
export function metricOf(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

export type PerformanceTotals = {
  impressions: number | null;
  reach: number | null;
  clicks: number | null;
  conversions: number | null;
  spendCents: number | null;
  revenueCents: number | null;
};

export type DerivedMetrics = {
  ctr: number | null;
  cvr: number | null;
  roas: number | null;
  cpaCents: number | null;
  cpcCents: number | null;
  cpmCents: number | null;
};

/** The paid totals of one stored performance row. A metric the row does not hold is null, never zero. */
export function performanceTotalsOf(row: Record<string, unknown>): PerformanceTotals {
  return {
    impressions: metricOf(row.impressions),
    reach: metricOf(row.reach),
    clicks: metricOf(row.clicks),
    conversions: metricOf(row.conversions),
    spendCents: metricOf(row.spend_cents),
    revenueCents: metricOf(row.revenue_cents),
  };
}

/** Rates from stored counts. A zero denominator, or an unknown input, stays null. Nothing is imputed. */
export function deriveMetrics(row: PerformanceTotals): DerivedMetrics {
  return {
    ctr: ratio(row.clicks, row.impressions),
    cvr: ratio(row.conversions, row.clicks),
    roas: ratio(row.revenueCents, row.spendCents),
    cpaCents: perCount(row.spendCents, row.conversions),
    cpcCents: perCount(row.spendCents, row.clicks),
    cpmCents: perThousand(row.spendCents, row.impressions),
  };
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10000) / 10000;
}

function perCount(total: number | null, count: number | null): number | null {
  if (total === null || count === null || count <= 0) return null;
  return Math.round(total / count);
}

function perThousand(total: number | null, impressions: number | null): number | null {
  if (total === null || impressions === null || impressions <= 0) return null;
  return Math.round((total / impressions) * 1000);
}
