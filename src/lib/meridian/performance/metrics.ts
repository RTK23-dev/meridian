export type PerformanceTotals = {
  impressions: number;
  reach: number;
  clicks: number;
  conversions: number;
  spendCents: number;
  revenueCents: number;
};

export type DerivedMetrics = {
  ctr: number | null;
  cvr: number | null;
  roas: number | null;
  cpaCents: number | null;
  cpcCents: number | null;
  cpmCents: number | null;
};

/** Rates from stored counts. A zero denominator stays null. Nothing is imputed. */
export function deriveMetrics(row: PerformanceTotals): DerivedMetrics {
  return {
    ctr: ratio(row.clicks, row.impressions),
    cvr: ratio(row.conversions, row.clicks),
    roas: ratio(row.revenueCents, row.spendCents),
    cpaCents: row.conversions > 0 ? Math.round(row.spendCents / row.conversions) : null,
    cpcCents: row.clicks > 0 ? Math.round(row.spendCents / row.clicks) : null,
    cpmCents: row.impressions > 0 ? Math.round((row.spendCents / row.impressions) * 1000) : null,
  };
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10000) / 10000;
}
