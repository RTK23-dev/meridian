/**
 * The lines the Factory board shows for a creative's publish receipts and its measured rows. Pure: the route passes the rows it loaded.
 * A value the source did not report reads "not reported". A zero the source reported reads as zero. A receipt with no external id was
 * not published, and its reason is shown. A paused paid ad is named as paused, never as live.
 */

export type ReceiptRow = {
  surface: "organic" | "paid";
  platform: string;
  status: string;
  externalId: string;
  reason: string;
};

export type MetricRowValues = {
  views: number | null;
  reach: number | null;
  impressions: number | null;
  clicks: number | null;
  shares: number | null;
  saves: number | null;
  conversions: number | null;
  spendCents: number | null;
  completionRate: number | null;
};

const RECEIPT_STATUS: Record<string, string> = {
  published: "published",
  scheduled: "scheduled",
  paused: "paused, not live",
  not_connected: "not connected",
  failed: "failed",
};

/** One receipt in plain words. A status the board does not know is shown as stored, never guessed. */
export function receiptLine(row: ReceiptRow): string {
  const surface = row.surface === "paid" ? "Paid" : "Organic";
  const status = RECEIPT_STATUS[row.status] ?? row.status;
  const id = row.externalId ? ` · id ${row.externalId}` : "";
  const reason = row.reason ? ` · ${row.reason}` : "";
  return `${surface} ${row.platform}: ${status}${id}${reason}`;
}

function count(value: number | null, label: string): string {
  return value == null ? `${label} not reported` : `${value} ${label}`;
}

/** One measured row in plain words. Each metric the source did not report says so. */
export function metricLine(surface: "organic" | "paid", metrics: MetricRowValues): string {
  if (surface === "paid") {
    const spend = metrics.spendCents == null ? "spend not reported" : `$${(metrics.spendCents / 100).toFixed(2)} spend`;
    return [count(metrics.impressions, "impressions"), count(metrics.clicks, "clicks"), spend, count(metrics.conversions, "conversions")].join(" · ");
  }
  const completion = metrics.completionRate == null ? "completion not reported" : `${(metrics.completionRate * 100).toFixed(1)}% completion`;
  return [count(metrics.views, "views"), count(metrics.shares, "shares"), count(metrics.saves, "saves"), completion].join(" · ");
}
