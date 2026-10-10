/**
 * Pure helpers for the performance charts. Definitions match the learning engine:
 * CTR = clicks / impressions, conversion rate = conversions / clicks, ROAS = revenue / spend.
 * A value whose denominator is zero is not a result, so it is returned as null and shown as
 * "Not enough results", never as 0.
 */

export const NOT_ENOUGH_RESULTS = "Not enough results";

export type PerformanceMetric = "ctr" | "conversion_rate" | "roas";

export const PERFORMANCE_METRICS: ReadonlyArray<{ key: PerformanceMetric; label: string; unit: "percent" | "multiple" }> = [
  { key: "ctr", label: "Click-through rate (clicks ÷ impressions)", unit: "percent" },
  { key: "conversion_rate", label: "Conversion rate (conversions ÷ clicks)", unit: "percent" },
  { key: "roas", label: "ROAS (revenue ÷ spend)", unit: "multiple" },
];

export type PerformanceRowInput = {
  creativeId: string;
  observedOn: string;
  impressions: number;
  clicks: number;
  conversions: number;
  spendCents: number;
  revenueCents: number;
};

export type MetricTotals = {
  rows: number;
  impressions: number;
  clicks: number;
  conversions: number;
  spendCents: number;
  revenueCents: number;
};

export type PerformancePoint = {
  key: string;
  label: string;
  totals: MetricTotals;
  /** null when the denominator for the selected metric is zero. */
  value: number | null;
};

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export function sumRows(rows: readonly PerformanceRowInput[]): MetricTotals {
  const totals: MetricTotals = { rows: 0, impressions: 0, clicks: 0, conversions: 0, spendCents: 0, revenueCents: 0 };
  for (const row of rows) {
    totals.rows += 1;
    totals.impressions += finite(row.impressions);
    totals.clicks += finite(row.clicks);
    totals.conversions += finite(row.conversions);
    totals.spendCents += finite(row.spendCents);
    totals.revenueCents += finite(row.revenueCents);
  }
  return totals;
}

/** The metric for a set of rows, or null when its denominator is zero (no results yet). */
export function metricValue(metric: PerformanceMetric, totals: MetricTotals): number | null {
  switch (metric) {
    case "ctr":
      return totals.impressions > 0 ? totals.clicks / totals.impressions : null;
    case "conversion_rate":
      return totals.clicks > 0 ? totals.conversions / totals.clicks : null;
    case "roas":
      return totals.spendCents > 0 ? totals.revenueCents / totals.spendCents : null;
  }
}

export function formatMetric(metric: PerformanceMetric, value: number | null): string {
  if (value === null || !Number.isFinite(value)) return NOT_ENOUGH_RESULTS;
  const unit = PERFORMANCE_METRICS.find((entry) => entry.key === metric)?.unit ?? "percent";
  return unit === "percent" ? `${(value * 100).toFixed(2)}%` : `${value.toFixed(2)}x`;
}

/** Impressions are the denominator for CTR, so zero impressions is not a result. */
export function formatImpressions(count: number): string {
  return count > 0 ? count.toLocaleString() : NOT_ENOUGH_RESULTS;
}

/** One point per creative, most impressions first. */
export function groupByCreative(rows: readonly PerformanceRowInput[], metric: PerformanceMetric): PerformancePoint[] {
  const byCreative = new Map<string, PerformanceRowInput[]>();
  for (const row of rows) {
    const key = row.creativeId || "Unlinked row";
    const bucket = byCreative.get(key);
    if (bucket) bucket.push(row);
    else byCreative.set(key, [row]);
  }
  return [...byCreative.entries()]
    .map(([key, bucket]) => {
      const totals = sumRows(bucket);
      return { key, label: key, totals, value: metricValue(metric, totals) };
    })
    .sort((left, right) => right.totals.impressions - left.totals.impressions || left.key.localeCompare(right.key));
}

/** One point per observed day, oldest first. Dates are YYYY-MM-DD strings, so they sort as text. */
export function groupByDay(rows: readonly PerformanceRowInput[], metric: PerformanceMetric): PerformancePoint[] {
  const byDay = new Map<string, PerformanceRowInput[]>();
  for (const row of rows) {
    const key = row.observedOn;
    const bucket = byDay.get(key);
    if (bucket) bucket.push(row);
    else byDay.set(key, [row]);
  }
  return [...byDay.entries()]
    .map(([key, bucket]) => {
      const totals = sumRows(bucket);
      return { key, label: key, totals, value: metricValue(metric, totals) };
    })
    .sort((left, right) => left.key.localeCompare(right.key));
}
