// Rates one reel's observed checkpoints against its creator's baseline: the tier (S, A, B or C), or null with the reason it is
// not rated (B2, NORTH_STAR section 5). The scoring is calculateInstantRating's, unchanged. This file decides only what may
// be rated, so no missing number is filled in.
//
// Null rules (AGENTS.md rule 1):
//  - no creator baseline (the median is null) -> not rated, with the baseline's reason;
//  - a zero median, so the ratio is undefined -> not rated;
//  - no checkpoint with both a view count and a comment count -> not rated;
//  - the creator's follower count is not reported by the sources, and the small-creator rule would change the tier -> not rated.
//    The rater reads followers only for that rule, so the tier is computed at both ends (no follower count, and a follower count
//    that rules the rule out). If the two tiers differ, the tier is not known.
//
// intentScore is not part of the outcome: it counts friend-tag comments, which no source reports yet, and a 0 would be a guess.

import { SnapshotScheduler, type RatingSnapshot } from "../discovery/snapshot-scheduler.ts";
import type { InstantRatingResult, InstantRatingTier } from "./instant-rating.ts";

/** Stands in for an unknown follower count at the low end: the small-creator rule can apply. */
export const FOLLOWERS_LOW_END = 0;
/** Stands in for an unknown follower count at the high end: the small-creator rule cannot apply. */
export const FOLLOWERS_HIGH_END = Number.MAX_SAFE_INTEGER;

export type ReelRatingInput = {
  /** The creator's median views, or null when no baseline could be measured. */
  creatorMedianViews: number | null;
  /** Why the baseline is missing, in words. Used only when creatorMedianViews is null. */
  baselineReason: string;
  /**
   * The checkpoints observed so far. `hoursSincePost` here is the hours since the first observation, the origin velocity is
   * measured from. Checkpoints without a view count or a comment count are left out by the caller.
   */
  snapshots: RatingSnapshot[];
};

export type ReelRatingOutcome = {
  tier: InstantRatingTier | null;
  /** Why the tier is null, in words. Empty when a tier is given. */
  reason: string;
  /** The rater's numbers at the latest checkpoint, or null when not rated. */
  result: InstantRatingResult | null;
  /** The view count of the latest checkpoint, or null when not rated. */
  viewsUsed: number | null;
};

function unrated(reason: string, viewsUsed: number | null = null): ReelRatingOutcome {
  return { tier: null, reason, result: null, viewsUsed };
}

function observed(snapshot: RatingSnapshot): boolean {
  return (
    Number.isFinite(snapshot.hoursSincePost) &&
    Number.isFinite(snapshot.views) &&
    snapshot.views >= 0 &&
    Number.isFinite(snapshot.comments) &&
    snapshot.comments >= 0
  );
}

/** Rates a reel from its checkpoints. Pure: it reads no database and sends nothing. */
export function rateReel(input: ReelRatingInput): ReelRatingOutcome {
  if (input.creatorMedianViews === null || !Number.isFinite(input.creatorMedianViews)) {
    const why = input.baselineReason.trim();
    return unrated(why ? `The creator's baseline is not known. ${why}` : "The creator's baseline is not known.");
  }
  if (input.creatorMedianViews <= 0) {
    return unrated("The creator's median view count is zero, so a ratio is not defined.");
  }
  const points = input.snapshots.filter(observed);
  if (points.length === 0) {
    return unrated("No checkpoint has both a view count and a comment count, so the reel cannot be rated.");
  }
  const latest = [...points].sort((a, b) => a.hoursSincePost - b.hoursSincePost).pop() as RatingSnapshot;
  const creatorMedianViews = input.creatorMedianViews;

  const low = SnapshotScheduler.recomputeRatingWithSnapshots({
    creatorFollowers: FOLLOWERS_LOW_END,
    creatorMedianViews,
    snapshots: points,
  });
  const high = SnapshotScheduler.recomputeRatingWithSnapshots({
    creatorFollowers: FOLLOWERS_HIGH_END,
    creatorMedianViews,
    snapshots: points,
  });
  if (low.ratingTier !== high.ratingTier) {
    return unrated(
      "The creator's follower count is not reported, and the small-creator rule would change this tier.",
      latest.views,
    );
  }
  return { tier: high.ratingTier, reason: "", result: high, viewsUsed: latest.views };
}
