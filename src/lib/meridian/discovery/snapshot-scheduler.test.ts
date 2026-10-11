import assert from "node:assert/strict";
import test from "node:test";
import { SnapshotScheduler } from "./snapshot-scheduler.ts";
import type { PostSnapshot } from "./types.ts";

test("SnapshotScheduler generates standard 0h, 6h, 24h, 72h schedule", () => {
  const postedAt = "2026-10-07T00:00:00.000Z";
  const schedule = SnapshotScheduler.generateSchedule("reel-abc-123", postedAt);

  assert.equal(schedule.length, 4);
  assert.equal(schedule[0].targetHoursSincePost, 0);
  assert.equal(schedule[0].scheduledFor, "2026-10-07T00:00:00.000Z");

  assert.equal(schedule[1].targetHoursSincePost, 6);
  assert.equal(schedule[1].scheduledFor, "2026-10-07T06:00:00.000Z");

  assert.equal(schedule[2].targetHoursSincePost, 24);
  assert.equal(schedule[2].scheduledFor, "2026-10-08T00:00:00.000Z");

  assert.equal(schedule[3].targetHoursSincePost, 72);
  assert.equal(schedule[3].scheduledFor, "2026-10-10T00:00:00.000Z");
});

test("SnapshotScheduler analyzes velocity slope and acceleration", () => {
  const snapshots: PostSnapshot[] = [
    {
      postId: "reel-1",
      hoursSincePost: 1,
      views: 500,
      likes: 40,
      comments: 5,
      friendTagComments: 1,
      capturedAt: "2026-10-07T01:00:00Z",
    },
    {
      postId: "reel-1",
      hoursSincePost: 6,
      views: 8000,
      likes: 600,
      comments: 90,
      friendTagComments: 20,
      capturedAt: "2026-10-07T06:00:00Z",
    },
    {
      postId: "reel-1",
      hoursSincePost: 24,
      views: 75000,
      likes: 5200,
      comments: 650,
      friendTagComments: 140,
      capturedAt: "2026-10-07T24:00:00Z",
    },
  ];

  const velocity = SnapshotScheduler.analyzeVelocity(snapshots);
  assert.equal(velocity.hoursElapsed, 23); // 24 - 1
  assert.ok(velocity.viewsGainPerHour > 3000);
  assert.ok(velocity.isExploding, "Reel velocity should be flagged as exploding");
});

test("SnapshotScheduler recomputes rating with longitudinal snapshots", () => {
  const snapshots: PostSnapshot[] = [
    {
      postId: "reel-1",
      hoursSincePost: 1,
      views: 1000,
      likes: 50,
      comments: 10,
      friendTagComments: 2,
      capturedAt: "2026-10-07T01:00:00Z",
    },
    {
      postId: "reel-1",
      hoursSincePost: 6,
      views: 45000,
      likes: 3200,
      comments: 380,
      friendTagComments: 80,
      capturedAt: "2026-10-07T06:00:00Z",
    },
  ];

  const rating = SnapshotScheduler.recomputeRatingWithSnapshots({
    creatorFollowers: 15000,
    creatorMedianViews: 3000,
    snapshots,
  });

  assert.equal(rating.outlierRatio, 15); // 45k / 3k
  assert.ok(rating.velocityScore !== null && rating.velocityScore > 50);
  assert.ok(["S", "A"].includes(rating.ratingTier));
});
