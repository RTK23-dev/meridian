/**
 * Longitudinal Snapshot Scheduler for Organic Candidate Reels
 * 
 * Tracks candidate post performance over time:
 * - Snapshots are taken at 0h (the discovery observation), +24h and +72h after the first snapshot (SNAPSHOT_CADENCE_HOURS).
 * - Computes view velocity (slope) and acceleration between intervals.
 * - Triggers re-rating via Empirical Bayes Instant Rating when snapshots arrive.
 */

import type { PostSnapshot, VelocityAnalysis } from "./types.ts";
import { calculateInstantRating, type InstantRatingResult } from "../grading/instant-rating.ts";

export interface ScheduledSnapshot {
  id: string;
  reelId: string;
  targetHoursSincePost: number;
  scheduledFor: string;
  completedAt?: string;
  status: "pending" | "completed" | "skipped" | "failed";
}

/**
 * The checkpoints, in hours after the first snapshot. The first snapshot is taken at discovery, so the offsets count from
 * discovery, not from posting: a reel found a week after it was posted still gets its +24h and +72h checkpoints.
 */
export const SNAPSHOT_CADENCE_HOURS = [0, 24, 72] as const;

/**
 * A checkpoint whose views and comments were observed. Likes, shares and friend-tag comments are optional, because the
 * sources do not always report them, and an absent value is never filled in with 0.
 */
export type RatingSnapshot = {
  hoursSincePost: number;
  views: number;
  comments: number;
  shares?: number;
  friendTagComments?: number;
};

export class SnapshotScheduler {
  /**
   * Generates the snapshot schedule for a newly discovered reel. `firstSnapshotIso` is the time of the first snapshot (discovery).
   */
  static generateSchedule(reelId: string, firstSnapshotIso: string): ScheduledSnapshot[] {
    const baseTime = new Date(firstSnapshotIso).getTime();

    return SNAPSHOT_CADENCE_HOURS.map((hours) => {
      const scheduledTime = new Date(baseTime + hours * 3600 * 1000);
      return {
        id: `snap-sched-${reelId}-${hours}h`,
        reelId,
        targetHoursSincePost: hours,
        scheduledFor: scheduledTime.toISOString(),
        status: "pending",
      };
    });
  }

  /**
   * Analyzes velocity across 2 or more longitudinal snapshots.
   */
  static analyzeVelocity(snapshots: PostSnapshot[]): VelocityAnalysis {
    if (snapshots.length < 2) {
      return {
        hoursElapsed: snapshots[0]?.hoursSincePost ?? 0,
        viewsGainPerHour: 0,
        accelerationScore: 0,
        isExploding: false,
      };
    }

    const sorted = [...snapshots].sort((a, b) => a.hoursSincePost - b.hoursSincePost);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];

    const timeDelta = Math.max(0.5, last.hoursSincePost - first.hoursSincePost);
    const viewsDelta = Math.max(0, last.views - first.views);
    const viewsGainPerHour = viewsDelta / timeDelta;

    // Acceleration: compare slope of first interval to slope of second interval if 3+ snapshots exist
    let accelerationScore = 0;
    if (sorted.length >= 3) {
      const mid = sorted[1];
      const delta1 = Math.max(0.5, mid.hoursSincePost - first.hoursSincePost);
      const slope1 = (mid.views - first.views) / delta1;

      const delta2 = Math.max(0.5, last.hoursSincePost - mid.hoursSincePost);
      const slope2 = (last.views - mid.views) / delta2;

      accelerationScore = slope1 > 0 ? (slope2 - slope1) / slope1 : slope2 > 0 ? 1 : 0;
    } else {
      // With 2 snapshots, velocity relative to raw view count provides acceleration proxy
      accelerationScore = viewsGainPerHour > 500 ? 1.0 : viewsGainPerHour > 100 ? 0.5 : 0;
    }

    const isExploding = viewsGainPerHour >= 2000 || accelerationScore >= 1.5;

    return {
      hoursElapsed: Number(timeDelta.toFixed(1)),
      viewsGainPerHour: Number(viewsGainPerHour.toFixed(1)),
      accelerationScore: Number(accelerationScore.toFixed(2)),
      isExploding,
    };
  }

  /**
   * Re-evaluates instant rating with latest snapshot series.
   */
  static recomputeRatingWithSnapshots(params: {
    creatorFollowers: number;
    creatorMedianViews: number;
    creatorVariance?: number;
    nichePriorMean?: number;
    nichePriorVariance?: number;
    snapshots: RatingSnapshot[];
  }): InstantRatingResult {
    const latest = [...params.snapshots].sort((a, b) => a.hoursSincePost - b.hoursSincePost).pop();
    if (!latest) {
      throw new Error("At least one snapshot is required to compute rating.");
    }

    return calculateInstantRating({
      views: latest.views,
      creatorFollowers: params.creatorFollowers,
      creatorMedianViews: params.creatorMedianViews,
      creatorVariance: params.creatorVariance,
      nichePriorMean: params.nichePriorMean,
      nichePriorVariance: params.nichePriorVariance,
      commentsCount: latest.comments,
      sharesCount: latest.shares,
      friendTagCommentsCount: latest.friendTagComments,
      snapshots: params.snapshots,
    });
  }
}
