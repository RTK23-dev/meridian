import assert from "node:assert/strict";
import test from "node:test";
import { calculateInstantRating, calculateVelocityScore } from "./instant-rating.ts";
import type { PostSnapshot } from "../discovery/types.ts";

test("calculateVelocityScore computes acceleration across multiple snapshots", () => {
  const snapshots: PostSnapshot[] = [
    {
      postId: "reel-1",
      hoursSincePost: 1,
      views: 100,
      likes: 10,
      comments: 2,
      friendTagComments: 0,
      capturedAt: "2026-10-07T01:00:00Z",
    },
    {
      postId: "reel-1",
      hoursSincePost: 6,
      views: 5000,
      likes: 500,
      comments: 120,
      friendTagComments: 25,
      capturedAt: "2026-10-07T06:00:00Z",
    },
  ];

  const score = calculateVelocityScore(snapshots);
  assert.ok(score !== null && score >= 60, `Expected high velocity score, got ${score}`);
});

test("calculateInstantRating performs Empirical Bayes shrinkage and computes accurate tiers", () => {
  // Scenario 1: S-Tier Outlier (Creator median is 5k, reel did 120k with high engagement)
  const resultS = calculateInstantRating({
    views: 120000,
    creatorFollowers: 12000,
    creatorMedianViews: 5000,
    creatorVariance: 0.8,
    nichePriorMean: 0.0,
    nichePriorVariance: 0.8,
    commentsCount: 650,
    sharesCount: 1800,
    friendTagCommentsCount: 210,
  });

  assert.equal(resultS.ratingTier, "S");
  assert.equal(resultS.outlierRatio, 24); // 120k / 5k
  assert.equal(resultS.isSmallCreatorBreakout, true); // 12k followers with 120k views
  assert.equal(resultS.isFitted, false); // Seed prior
  assert.ok(resultS.shrunkOutlierScore > 1.5);
  assert.ok(resultS.confidenceInterval.low < resultS.shrunkOutlierScore);
  assert.ok(resultS.confidenceInterval.high > resultS.shrunkOutlierScore);

  // Scenario 2: High variance creator shrunk toward normal
  const noisyCreator = calculateInstantRating({
    views: 15000,
    creatorFollowers: 50000,
    creatorMedianViews: 5000,
    creatorVariance: 4.0, // High variance
    nichePriorMean: 0.0,
    nichePriorVariance: 0.8, // Low prior variance
    commentsCount: 20,
    sharesCount: 10,
  });

  // Shrinkage pulls 3x outlier significantly down due to creator's noisy history
  assert.ok(noisyCreator.shrunkOutlierScore < Math.log(3));
  assert.equal(noisyCreator.isSmallCreatorBreakout, false);

  // Scenario 3: Average post (1x median) receives C tier
  const averagePost = calculateInstantRating({
    views: 5200,
    creatorFollowers: 40000,
    creatorMedianViews: 5000,
    commentsCount: 15,
  });

  assert.equal(averagePost.ratingTier, "C");
  assert.equal(averagePost.outlierRatio, 1.04);
});

test("a single snapshot is not a neutral velocity: velocity is not observed and does not lift the tier", () => {
  assert.equal(calculateVelocityScore([]), null);
  const oneSnapshot: PostSnapshot[] = [
    { postId: "reel-2", hoursSincePost: 2, views: 9000, likes: 10, comments: 1, friendTagComments: 0, capturedAt: "2026-10-07T02:00:00Z" },
  ];
  const result = calculateInstantRating({
    views: 6000,
    creatorFollowers: 40000,
    creatorMedianViews: 5000,
    commentsCount: 40,
    snapshots: oneSnapshot,
  });
  assert.equal(result.velocityScore, null);
  assert.ok(result.evidenceSummary.some((line) => line.includes("Velocity: not observed")));
});

test("shares are never estimated from friend tags: an unobserved share count is a lower bound", () => {
  const withoutShares = calculateInstantRating({
    views: 20000,
    creatorFollowers: 40000,
    creatorMedianViews: 5000,
    commentsCount: 20,
    friendTagCommentsCount: 20,
  });
  assert.equal(withoutShares.sharesObserved, false);
  assert.equal(withoutShares.actionScoreIsLowerBound, true);
  // Comments only: 20 actions over 20,000 views is 1 action per 1k views, with no 2.5x share estimate added.
  assert.ok(withoutShares.evidenceSummary.some((line) => line.includes("1.0 actions/1k views (shares not observed")));
});

test("a rating with the default variance priors says so, and a measured rating does not", () => {
  const seed = calculateInstantRating({ views: 6000, creatorFollowers: 40000, creatorMedianViews: 5000, commentsCount: 10 });
  assert.equal(seed.priorSource, "seed_default");
  const measured = calculateInstantRating({
    views: 6000,
    creatorFollowers: 40000,
    creatorMedianViews: 5000,
    commentsCount: 10,
    creatorVariance: 0.9,
    nichePriorVariance: 0.7,
  });
  assert.equal(measured.priorSource, "supplied");
  assert.ok(!measured.evidenceSummary.some((line) => line.includes("seed defaults")));
});
