/**
 * JEV Instant Rating System
 * Evaluates whether an organic Reel is a true structural outlier against its creator's normal baseline.
 * Uses Empirical Bayes shrinkage, multi-snapshot velocity curves, action rates, and comment intent.
 */

import type { PostSnapshot } from "../discovery/types.ts";

export type InstantRatingTier = "S" | "A" | "B" | "C";

export interface InstantRatingInput {
  views: number;
  creatorFollowers: number;
  creatorMedianViews: number;
  creatorVariance?: number;
  nichePriorMean?: number;
  nichePriorVariance?: number;
  snapshots?: PostSnapshot[];
  commentsCount: number;
  sharesCount?: number | null;
  friendTagCommentsCount?: number;
}

export interface InstantRatingResult {
  outlierRatio: number;
  shrunkOutlierScore: number;
  velocityScore: number;
  actionScore: number;
  intentScore: number;
  ratingTier: InstantRatingTier;
  confidenceInterval: {
    low: number;
    high: number;
  };
  isSmallCreatorBreakout: boolean;
  isFitted: boolean;
  evidenceSummary: string[];
}

/**
 * Calculates views acceleration slope from multiple snapshot checkpoints (0h, 6h, 24h, 72h).
 */
export function calculateVelocityScore(snapshots: PostSnapshot[] = []): number {
  if (snapshots.length < 2) return 50.0; // neutral default when only 1 snapshot exists

  const sorted = [...snapshots].sort((a, b) => a.hoursSincePost - b.hoursSincePost);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const deltaHours = Math.max(0.5, last.hoursSincePost - first.hoursSincePost);
  const deltaViews = Math.max(0, last.views - first.views);

  const viewsPerHour = deltaViews / deltaHours;
  // Normalized velocity score on log scale (e.g. 50 views/hr -> 40, 500 -> 70, 5000 -> 95)
  const score = Math.min(100, Math.max(0, (Math.log10(Math.max(1, viewsPerHour)) / 4.5) * 100));
  return Number(score.toFixed(1));
}

/**
 * Computes the Instant Rating for an organic reel.
 */
export function calculateInstantRating(input: InstantRatingInput): InstantRatingResult {
  const safeViews = Math.max(1, input.views);
  const safeMedian = Math.max(1, input.creatorMedianViews);
  const rawRatio = safeViews / safeMedian;
  const rawLogOutlier = Math.log(rawRatio);

  // Empirical Bayes Shrinkage
  // sigma^2 = creator variance; tau^2 = niche prior variance
  const sigma2 = Math.max(0.1, input.creatorVariance ?? 1.2);
  const tau2 = Math.max(0.1, input.nichePriorVariance ?? 0.8);
  const nicheMean = input.nichePriorMean ?? 0.0;

  const shrinkageFactor = tau2 / (sigma2 + tau2);
  const shrunkScore = shrinkageFactor * rawLogOutlier + (1 - shrinkageFactor) * nicheMean;

  // Velocity
  const velocityScore = calculateVelocityScore(input.snapshots);

  // Action Rate: (comments + shares) per 1k views
  const estimatedShares = input.sharesCount ?? ((input.friendTagCommentsCount ?? 0) * 2.5);
  const totalActions = input.commentsCount + estimatedShares;
  const actionsPerK = (totalActions / safeViews) * 1000;
  // Organic benchmark: 4 actions/1k is typical (score ~40), 16 actions/1k is top decile (score ~70), 36+ is viral outlier (score ~90-100)
  const actionScore = Math.min(100, Math.max(0, (Math.sqrt(Math.max(0, actionsPerK)) / 6) * 100));

  // Comment Intent Score: ratio of comments that tag friends, ask for links, or show high buy/try intent
  const friendTags = input.friendTagCommentsCount ?? 0;
  const intentScore = input.commentsCount > 0
    ? Math.min(100, Math.max(0, (friendTags / input.commentsCount) * 250))
    : 0;

  // Small Creator Breakout: creators under 25k followers whose format carried them to 100k+ views
  const isSmallCreatorBreakout = input.creatorFollowers < 25000 && safeViews >= 100000;

  // Tier Assignment Logic
  let ratingTier: InstantRatingTier = "C";
  if ((shrunkScore >= 2.0 || (isSmallCreatorBreakout && shrunkScore >= 1.5)) && actionScore >= 50) {
    ratingTier = "S";
  } else if (shrunkScore >= 1.3 && actionScore >= 35) {
    ratingTier = "A";
  } else if (shrunkScore >= 0.6) {
    ratingTier = "B";
  }

  // Evidence Summary
  const evidence: string[] = [
    `${rawRatio.toFixed(1)}x creator median views (${safeViews.toLocaleString()} vs ${safeMedian.toLocaleString()})`,
    `Shrunk outlier score: ${shrunkScore.toFixed(2)} (shrinkage weight: ${(shrinkageFactor * 100).toFixed(0)}%)`,
    `Velocity: ${velocityScore}/100`,
    `Action rate: ${actionsPerK.toFixed(1)} actions/1k views`,
  ];
  if (isSmallCreatorBreakout) {
    evidence.push(`Small creator breakout: ${input.creatorFollowers.toLocaleString()} followers reached ${safeViews.toLocaleString()} views`);
  }

  // Standard Error calculation for confidence interval
  const se = Math.sqrt((sigma2 * tau2) / (sigma2 + tau2));

  return {
    outlierRatio: Number(rawRatio.toFixed(2)),
    shrunkOutlierScore: Number(shrunkScore.toFixed(2)),
    velocityScore,
    actionScore: Number(actionScore.toFixed(1)),
    intentScore: Number(intentScore.toFixed(1)),
    ratingTier,
    confidenceInterval: {
      low: Number((shrunkScore - 1.96 * se).toFixed(2)),
      high: Number((shrunkScore + 1.96 * se).toFixed(2)),
    },
    isSmallCreatorBreakout,
    isFitted: false, // Seed heuristic until calibrated with real own-account telemetry
    evidenceSummary: evidence,
  };
}
