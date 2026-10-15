// The reel rating wrapper: what may be rated, and what is shown as not rated. The tiers are the rater's own (instant-rating.ts);
// each expected tier below was worked out from its formulas with the default priors (variance 1.2 and 0.8, so the shrinkage weight
// is 0.4 and the outlier score is 0.4 times the log of the ratio).

import assert from "node:assert/strict";
import test from "node:test";
import type { RatingSnapshot } from "../discovery/snapshot-scheduler.ts";
import { rateReel } from "./reel-rating.ts";

const FIRST: RatingSnapshot = { hoursSincePost: 0, views: 12100, comments: 85 };

test("with no creator baseline a reel is not rated, and the baseline's reason is shown", () => {
  const outcome = rateReel({
    creatorMedianViews: null,
    baselineReason: "Only 3 of the last 3 reels report a view count; 10 are needed for a creator median.",
    snapshots: [FIRST],
  });
  assert.equal(outcome.tier, null);
  assert.equal(outcome.result, null);
  assert.match(outcome.reason, /baseline is not known\. Only 3 of the last 3 reels/);
});

test("a zero median is not rated: the ratio is not defined", () => {
  const outcome = rateReel({ creatorMedianViews: 0, baselineReason: "", snapshots: [FIRST] });
  assert.equal(outcome.tier, null);
  assert.match(outcome.reason, /median view count is zero/);
});

test("a reel with no checkpoint that has both views and comments is not rated", () => {
  const outcome = rateReel({ creatorMedianViews: 6500, baselineReason: "", snapshots: [] });
  assert.equal(outcome.tier, null);
  assert.match(outcome.reason, /No checkpoint has both a view count and a comment count/);
});

test("a reel that is 1.9 times its creator's median with a normal comment count is rated C, with the numbers it used", () => {
  const outcome = rateReel({ creatorMedianViews: 6500, baselineReason: "", snapshots: [FIRST] });
  assert.equal(outcome.tier, "C");
  assert.equal(outcome.reason, "");
  assert.equal(outcome.viewsUsed, 12100);
  assert.ok(outcome.result, "the rater's numbers are kept");
  assert.equal(outcome.result.outlierRatio, 1.86);
});

test("a very large outlier with a high action rate is rated S whatever the follower count is", () => {
  // Ratio 500: outlier score 0.4 * ln(500) = 2.49, and 20 actions per 1,000 views gives an action score of about 74.
  const outcome = rateReel({
    creatorMedianViews: 1000,
    baselineReason: "",
    snapshots: [{ hoursSincePost: 0, views: 500000, comments: 10000 }],
  });
  assert.equal(outcome.tier, "S");
  assert.equal(outcome.reason, "");
});

test("a tier that depends on whether the creator is small is not rated, because the follower count is not reported", () => {
  // Ratio 50 at 100,000 views: outlier score 0.4 * ln(50) = 1.56. With under 25,000 followers the small-creator rule gives S;
  // without it the same reel is A. The follower count decides the tier, so the tier is not known.
  const outcome = rateReel({
    creatorMedianViews: 2000,
    baselineReason: "",
    snapshots: [{ hoursSincePost: 0, views: 100000, comments: 1000 }],
  });
  assert.equal(outcome.tier, null);
  assert.match(outcome.reason, /follower count is not reported, and the small-creator rule would change this tier/);
  assert.equal(outcome.viewsUsed, 100000);
});

test("the latest checkpoint is the one rated, and its views are the views used", () => {
  const outcome = rateReel({
    creatorMedianViews: 6500,
    baselineReason: "",
    snapshots: [
      { hoursSincePost: 24, views: 12000, comments: 50 },
      { hoursSincePost: 0, views: 1000, comments: 4 },
    ],
  });
  assert.equal(outcome.tier, "C");
  assert.equal(outcome.viewsUsed, 12000);
});
