export type OrganicMetricValues = {
  views: number | null;
  threeSecondViews: number | null;
  completionRate: number | null;
  shares: number | null;
};

/**
 * The metrics line for one organic post. A value the platform did not report reads "not reported". Zero is a value the
 * platform reported, so it reads as zero.
 */
export function organicMetricsLine(post: OrganicMetricValues): string {
  const count = (value: number | null, label: string) => (value == null ? `${label} not reported` : `${value} ${label}`);
  const completion = post.completionRate == null ? "completion not reported" : `${(post.completionRate * 100).toFixed(1)}% completion`;
  return [count(post.views, "views"), count(post.threeSecondViews, "3s hook"), completion, count(post.shares, "shares")].join(" · ");
}
