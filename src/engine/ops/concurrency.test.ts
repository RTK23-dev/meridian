// Concurrency sizing (Video Engine Bible 10.4, 15.1, 19 E6). The proposals are checked on fixed attempts and a fixed clock. A size is
// never moved on a guess: too little data holds, a 429 share over the limit shrinks, and growth needs measured headroom.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bucketClassFor, type BucketClass } from "../assets/buckets.ts";
import { BUCKET_CLASSES, latencyTrend, proposeConcurrency, routeBucketMap, type ConcurrencyAttempt, type ConcurrencyInput, type ConcurrencyProposal } from "./concurrency.ts";
import { proposedOpsThresholds } from "./thresholds.ts";

const NOW = 10_000_000;
const HOUR = 3_600_000;
const limits = proposedOpsThresholds.concurrency;
const current = { video: 10, image: 20, tts: 30 };

function bucketOf(providerId: string): BucketClass | null {
  if (providerId.startsWith("video")) return "video";
  if (providerId.startsWith("image")) return "image";
  return null;
}

function attempt(providerId: string, outcome: ConcurrencyAttempt["outcome"], atMs: number, latencyMs: number | null, errorKind: string | null = null): ConcurrencyAttempt {
  return { providerId, outcome, errorKind, latencyMs, atMs };
}

function healthy(count: number, atMs = NOW - 1_000, latencyMs = 100, providerId = "video-a"): ConcurrencyAttempt[] {
  return Array.from({ length: count }, () => attempt(providerId, "success", atMs, latencyMs));
}

function run(attempts: ConcurrencyAttempt[], extra: Partial<ConcurrencyInput> = {}): Record<BucketClass, ConcurrencyProposal> {
  const proposals = proposeConcurrency({ current, nowMs: NOW, attempts, thresholds: limits, bucketOf, ...extra });
  return Object.fromEntries(proposals.map((proposal) => [proposal.bucket, proposal])) as Record<BucketClass, ConcurrencyProposal>;
}

describe("concurrency proposals (Bible 10.4, 15.1)", () => {
  test("too few provider-side attempts hold the size", () => {
    const video = run(healthy(3)).video;
    assert.equal(video.basis, "insufficient_data");
    assert.equal(video.proposed, 10);
    assert.equal(video.providerSideAttempts, 3);
  });

  test("attempts outside the window, and refused requests, are not evidence", () => {
    assert.equal(run(healthy(20, NOW - 2 * HOUR)).video.basis, "insufficient_data");
    const refused = Array.from({ length: 20 }, () => attempt("video-a", "request_refused", NOW - 1_000, null, "content_policy"));
    assert.equal(run(refused).video.basis, "insufficient_data");
  });

  test("a 429 share over the limit shrinks the bucket by the factor, never below its floor", () => {
    const rateLimited = [attempt("video-a", "provider_failure", NOW - 1_000, null, "rate_limit"), attempt("video-a", "provider_failure", NOW - 1_000, null, "rate_limit")];
    const video = run([...healthy(18), ...rateLimited]).video;
    assert.equal(video.basis, "rate_limited");
    assert.equal(video.rateLimitShare, 0.1);
    assert.equal(video.proposed, 7);
    const floored = run([...healthy(18), ...rateLimited], { current: { video: 2, image: 20, tts: 30 } }).video;
    assert.equal(floored.proposed, 2, "the floor holds");
  });

  test("growth needs measured headroom: a full bucket, no 429s and flat latency", () => {
    const grown = run(healthy(20), { saturation: { video: 0.8 } }).video;
    assert.equal(grown.basis, "headroom_measured");
    assert.equal(grown.proposed, 11);
    assert.equal(grown.saturation, 0.8);
  });

  test("with no saturation measured, or a bucket that was rarely full, the size is held", () => {
    const unmeasured = run(healthy(20)).video;
    assert.equal(unmeasured.basis, "held");
    assert.equal(unmeasured.proposed, 10);
    const rarelyFull = run(healthy(20), { saturation: { video: 0.3 } }).video;
    assert.equal(rarelyFull.basis, "held");
    assert.equal(rarelyFull.proposed, 10);
  });

  test("rising latency holds growth, because more calls would only queue", () => {
    const attempts = [...healthy(10, NOW - 2_000_000, 100), ...healthy(10, NOW - 1_000, 300)];
    const held = run(attempts, { saturation: { video: 0.9 } }).video;
    assert.equal(held.basis, "held");
    assert.equal(held.latencyRatio, 3);
    assert.equal(held.proposed, 10);
  });

  test("some 429s below the share limit still hold the size", () => {
    const attempts = [...healthy(39), attempt("video-a", "provider_failure", NOW - 1_000, null, "rate_limit")];
    const held = run(attempts, { saturation: { video: 0.9 } }).video;
    assert.equal(held.basis, "held");
    assert.equal(held.rateLimitShare, 0.025);
    assert.equal(held.proposed, 10);
  });

  test("a bucket at its ceiling is held there, and a current size outside the bounds is brought inside them", () => {
    const atCeiling = run(healthy(20), { current: { video: 20, image: 20, tts: 30 }, saturation: { video: 0.8 } }).video;
    assert.equal(atCeiling.basis, "held");
    assert.equal(atCeiling.proposed, 20);
    const above = run(healthy(20), { current: { video: 50, image: 20, tts: 30 }, saturation: { video: 0.8 } }).video;
    assert.equal(above.proposed, limits.bounds.video.ceiling);
  });

  test("a bucket with no attempts holds its current size, inside its bounds", () => {
    const sizing = run([]);
    assert.equal(sizing.image.basis, "insufficient_data");
    assert.equal(sizing.image.proposed, 20);
    assert.equal(sizing.image.floor, limits.bounds.image.floor);
    assert.equal(sizing.image.ceiling, limits.bounds.image.ceiling);
  });
});

describe("latency trend and route buckets", () => {
  test("the trend is the late-half median over the early-half median, rounded to four decimals, and null without both halves", () => {
    const start = NOW - HOUR;
    const sampled = [attempt("video-a", "success", NOW - 2_000_000, 100), attempt("video-a", "success", NOW - 1_000, 150)];
    assert.equal(latencyTrend(sampled, start, NOW), 1.5);
    assert.equal(latencyTrend([attempt("video-a", "success", NOW - 1_000, 150)], start, NOW), null);
  });

  test("every route's bucket is one of the three classes, and an image model is an image bucket", () => {
    const map = routeBucketMap();
    assert.ok(map.size > 0);
    for (const bucket of map.values()) assert.ok(BUCKET_CLASSES.includes(bucket));
    assert.equal(bucketClassFor("image.keyframe"), "image");
    assert.equal(bucketClassFor("tts"), "tts");
    assert.equal(bucketClassFor("video.cinematic"), "video");
  });
});
