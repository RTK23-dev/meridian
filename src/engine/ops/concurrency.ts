// Concurrency sizing from measured provider stats (Video Engine Bible 10.4, 15.1, 15.2, 19 E6). It PROPOSES a size for each concurrency
// bucket (video, image, tts) from the attempt history: the share of 429 responses and the latency trend. It writes nothing. The lead
// reads the proposals and changes config/thresholds.ts (router.concurrency) if accepted.
//
// Rules, in order (every number is in ops/thresholds.ts, marked proposed unless the Bible gives it):
//   1. Too few provider-side attempts in the window: hold. A size is never moved on a guess (the router's minAttempts).
//   2. A 429 share over the limit: shrink the bucket by the shrink factor, never below its floor.
//   3. Growth needs measured headroom: saturation (the share of sampled moments the bucket was full) must be supplied and at or above
//      its minimum, there must be no 429s, and latency must not be rising. Without a saturation measurement the bucket is held. The router
//      does not record a full bucket as an attempt, so the caller must supply it (STATUS.md).
//   4. A proposal is always inside the bucket's bounds, even when the current size is outside them.

import { MODEL_CLASSES } from "../contracts/plan.ts";
import { routes } from "../config/routes.ts";
import { bucketClassFor, type BucketClass } from "../assets/buckets.ts";
import { percentile, rateOf } from "./distribution.ts";
import type { OpsThresholds } from "./thresholds.ts";

export const BUCKET_CLASSES: readonly BucketClass[] = ["video", "image", "tts"];

export type ConcurrencyAttempt = {
  providerId: string;
  outcome: "success" | "provider_failure" | "request_refused";
  errorKind: string | null;
  latencyMs: number | null;
  atMs: number;
};

export type ConcurrencyInput = {
  /** The current size of each bucket (config/thresholds.ts router.concurrency). */
  current: Record<BucketClass, number>;
  nowMs: number;
  attempts: readonly ConcurrencyAttempt[];
  /**
   * The share of sampled moments each bucket was full (in-flight at its limit), from the caller's own sampling of engine_bucket_leases. Absent,
   * or absent for a class, means no headroom was measured, so growth is held.
   */
  saturation?: Partial<Record<BucketClass, number>>;
  thresholds: OpsThresholds["concurrency"];
  /** Maps a provider id (provider:model) to its bucket. Defaults to the route table. */
  bucketOf?: (providerId: string) => BucketClass | null;
};

export type ConcurrencyBasis = "insufficient_data" | "rate_limited" | "headroom_measured" | "held";

export type ConcurrencyProposal = {
  bucket: BucketClass;
  current: number;
  proposed: number;
  floor: number;
  ceiling: number;
  basis: ConcurrencyBasis;
  providerSideAttempts: number;
  rateLimitShare: number | null;
  saturation: number | null;
  /** Late-half median latency over early-half median latency, or null when either half has no latency. */
  latencyRatio: number | null;
  reason: string;
};

/** The bucket each model-class provider id (provider:model, as the router names its adapters) belongs to, from the route table. */
export function routeBucketMap(): Map<string, BucketClass> {
  const map = new Map<string, BucketClass>();
  for (const [capability, route] of Object.entries(routes.table)) {
    if (!(MODEL_CLASSES as readonly string[]).includes(capability)) continue;
    for (const target of route.targets) {
      if (target.model === null) continue;
      map.set(`${target.provider}:${target.model}`, bucketClassFor(capability));
    }
  }
  return map;
}

function clamp(value: number, floor: number, ceiling: number): number {
  return Math.min(ceiling, Math.max(floor, value));
}

/** One proposal per bucket class, in BUCKET_CLASSES order. Pure. */
export function proposeConcurrency(input: ConcurrencyInput): ConcurrencyProposal[] {
  const t = input.thresholds;
  const map = routeBucketMap();
  const bucketOf = input.bucketOf ?? ((providerId: string) => map.get(providerId) ?? null);
  const windowStart = input.nowMs - t.windowMs;
  const inWindow = input.attempts.filter((attempt) => attempt.atMs >= windowStart && attempt.atMs <= input.nowMs && attempt.outcome !== "request_refused");

  return BUCKET_CLASSES.map((bucket): ConcurrencyProposal => {
    const bounds = t.bounds[bucket];
    const current = input.current[bucket];
    const base = clamp(current, bounds.floor, bounds.ceiling);
    const mine = inWindow.filter((attempt) => bucketOf(attempt.providerId) === bucket);
    const rateLimited = mine.filter((attempt) => attempt.errorKind === "rate_limit").length;
    const share = rateOf(rateLimited, mine.length);
    const saturation = input.saturation?.[bucket] ?? null;
    const latencyRatio = latencyTrend(mine, windowStart, input.nowMs);
    const common = { bucket, current, floor: bounds.floor, ceiling: bounds.ceiling, providerSideAttempts: mine.length, rateLimitShare: share, saturation, latencyRatio };
    const hold = (basis: ConcurrencyBasis, proposed: number, reason: string): ConcurrencyProposal => ({ ...common, basis, proposed, reason });

    if (mine.length < t.minAttempts) {
      return hold("insufficient_data", base, `${mine.length} provider-side attempts in the window, below ${t.minAttempts}: size held`);
    }
    if (share !== null && share > t.rateLimitShareMax) {
      const shrunk = Math.min(base, clamp(Math.floor(base * t.shrinkFactor), bounds.floor, bounds.ceiling));
      return { ...common, basis: "rate_limited", proposed: shrunk, reason: `429 share ${share} is over ${t.rateLimitShareMax}: shrink by ${t.shrinkFactor}` };
    }
    if (saturation === null) {
      return hold("held", base, "no saturation was measured, so no headroom is proven: size held");
    }
    if (saturation < t.saturationMin) {
      return hold("held", base, `saturation ${saturation} is under ${t.saturationMin}: the bucket was not full often enough to grow`);
    }
    if (latencyRatio !== null && latencyRatio > t.latencyRisingRatio) {
      return hold("held", base, `latency rose ${latencyRatio} times across the window, over ${t.latencyRisingRatio}: no growth under congestion`);
    }
    if (rateLimited > 0) {
      return hold("held", base, "some 429s in the window but not over the share limit: size held");
    }
    if (base >= bounds.ceiling) {
      return hold("held", base, "already at the ceiling");
    }
    const step = Math.max(1, Math.round(base * t.growShare));
    return { ...common, basis: "headroom_measured", proposed: clamp(base + step, bounds.floor, bounds.ceiling), reason: `no 429s, saturation ${saturation}: grow by ${step}` };
  });
}

/** The late-half over early-half median latency of successful attempts, or null when a half has no latency sample. */
export function latencyTrend(attempts: readonly ConcurrencyAttempt[], startMs: number, endMs: number): number | null {
  const middle = startMs + (endMs - startMs) / 2;
  const sampled = attempts.filter((attempt) => attempt.outcome === "success" && attempt.latencyMs !== null);
  const early = percentile(sampled.filter((attempt) => attempt.atMs < middle).map((attempt) => attempt.latencyMs as number), 50);
  const late = percentile(sampled.filter((attempt) => attempt.atMs >= middle).map((attempt) => attempt.latencyMs as number), 50);
  if (early === null || late === null || early <= 0) return null;
  return Math.round((late / early) * 10_000) / 10_000;
}
