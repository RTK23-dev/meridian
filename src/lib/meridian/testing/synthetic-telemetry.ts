/**
 * Synthetic Telemetry Testing Utilities
 *
 * For unit and integration tests only. Never used in production telemetry ingestion.
 */

export type SyntheticMetricSeed = {
  views: number;
  threeSecondViews: number;
  completionRate: number;
  shares: number;
  likes: number;
  comments: number;
  saves: number;
  synthetic: true;
};

export function createSyntheticTelemetryFixture(seedKey = "seed_1"): SyntheticMetricSeed {
  const seed = seedKey.length % 5;
  const views = 2400 + seed * 600;
  const retentionRate = 0.45 + (seed * 0.08);
  const threeSecondViews = Math.round(views * retentionRate);
  const completionRate = Number((0.25 + seed * 0.05).toFixed(4));
  const shares = Math.round(views * (0.02 + seed * 0.01));
  const likes = Math.round(views * 0.08);

  return {
    views,
    threeSecondViews,
    completionRate,
    shares,
    likes,
    comments: Math.round(likes * 0.15),
    saves: Math.round(likes * 0.2),
    synthetic: true,
  };
}
