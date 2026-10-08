import {
  assertSameTenant,
  type LearnedPattern,
  type LearningState,
  type ObservedCreative,
  type PerformanceRow,
  type OrganicObservationRow,
} from "../domain.ts";
import {
  baselinePrior,
  betaInterval,
  betaMean,
  bhQValues,
  jeffreysPrior,
  probabilityGreater,
  updateBeta,
  type BetaParams,
} from "../stats/beta.ts";

export const DEFAULT_LEARNING_POLICY = {
  /** Soft prior strength. Not a hard floor that crowns noise. */
  priorStrength: 8,
  /** BH false-discovery rate used to keep a pattern. */
  fdr: 0.15,
  /** Below this posterior chance, a pattern is not stored. */
  minPBeat: 0.8,
  inferredMinImpressions: 800,
  validatedMinCreatives: 4,
  validatedMinImpressions: 2000,
  validatedMinPBeat: 0.95,
};

const ATTRIBUTES = ["angle", "hookType", "format", "proofType", "visualStyle", "platform", "offer", "cta"] as const;

const PAIRS = [
  ["angle", "hookType"],
  ["angle", "format"],
  ["hookType", "format"],
  ["productName", "angle"],
  ["visualStyle", "format"],
] as const;

type Totals = {
  impressions: number;
  clicks: number;
  conversions: number;
  spendCents: number;
  revenueCents: number;
  roasSpend: number;
  creativeIds: Set<string>;
};

function emptyTotals(): Totals {
  return {
    impressions: 0,
    clicks: 0,
    conversions: 0,
    spendCents: 0,
    revenueCents: 0,
    roasSpend: 0,
    creativeIds: new Set(),
  };
}

function add(totals: Totals, row: PerformanceRow): void {
  totals.impressions += row.impressions;
  totals.clicks += row.clicks;
  totals.conversions += row.conversions;
  totals.spendCents += row.spendCents;
  if (row.revenueCents != null) {
    totals.revenueCents += row.revenueCents;
    totals.roasSpend += row.spendCents;
  }
  totals.creativeIds.add(row.creativeId);
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

function learningState(
  sampleSize: number,
  impressions: number,
  pBeat: number,
  policy: typeof DEFAULT_LEARNING_POLICY,
): LearningState {
  if (
    sampleSize >= policy.validatedMinCreatives &&
    impressions >= policy.validatedMinImpressions &&
    pBeat >= policy.validatedMinPBeat
  ) {
    return "VALIDATED";
  }
  if (impressions >= policy.inferredMinImpressions) return "INFERRED";
  return "OBSERVED";
}

/**
 * How much a stored pattern may move a future score.
 * OBSERVED is recorded but discounted. VALIDATED is still not a causal proof.
 */
export function patternInfluence(pattern: LearnedPattern): number {
  if (pattern.state === "VALIDATED") return 1;
  if (pattern.state === "OBSERVED") return 0.45;
  return 0.75;
}

export type LearningDirection = "POSITIVE" | "NEGATIVE" | "NEUTRAL" | "INSUFFICIENT_EVIDENCE";

/**
 * Direction comes from the posterior chance a pattern beats baseline, with a
 * credible interval. Thin or overlapping intervals stay insufficient.
 */
export function learningDirection(pattern: {
  lift: number;
  sampleSize: number;
  impressions: number;
  pBeat?: number;
  ciLow?: number;
  ciHigh?: number;
}): LearningDirection {
  const impressions = Number(pattern.impressions);
  const sampleSize = Number(pattern.sampleSize);
  if (!Number.isFinite(sampleSize) || !Number.isFinite(impressions) || sampleSize < 1 || impressions < 1) {
    return "INSUFFICIENT_EVIDENCE";
  }
  const pBeat = pattern.pBeat;
  if (typeof pBeat === "number" && Number.isFinite(pBeat)) {
    const ciLow = pattern.ciLow;
    const ciHigh = pattern.ciHigh;
    if (typeof ciLow === "number" && typeof ciHigh === "number" && ciLow <= 0 && ciHigh >= 0) {
      return "NEUTRAL";
    }
    if (pBeat >= 0.8) return "POSITIVE";
    if (pBeat <= 0.2) return "NEGATIVE";
    return "NEUTRAL";
  }
  // Legacy rows without a posterior: do not crown two creatives as a winner.
  if (sampleSize < 3 || impressions < 300) return "INSUFFICIENT_EVIDENCE";
  if (!Number.isFinite(pattern.lift) || Math.abs(pattern.lift) < 0.05) return "NEUTRAL";
  if (pattern.lift > 0) return "POSITIVE";
  return "NEGATIVE";
}

type Policy = typeof DEFAULT_LEARNING_POLICY;

type Candidate = {
  organizationId: string;
  brandId: string;
  attribute: string;
  value: string;
  metric: LearnedPattern["metric"];
  lift: number;
  observed: number;
  baseline: number;
  pBeat: number;
  ciLow: number;
  ciHigh: number;
  bucket: Totals;
  summary: string;
};

function twoSidedP(pBeat: number): number {
  return 2 * Math.min(pBeat, 1 - pBeat);
}

function relativeLift(observed: number, baseline: number): number | null {
  if (baseline === 0) return null;
  return (observed - baseline) / baseline;
}

function ctrCandidate(
  input: {
    organizationId: string;
    brandId: string;
    attribute: string;
    value: string;
    bucket: Totals;
    baseline: Totals;
    policy: Policy;
  },
): Candidate | null {
  const observed = rate(input.bucket.clicks, input.bucket.impressions);
  const baselineRate = rate(input.baseline.clicks, input.baseline.impressions);
  if (observed === null || baselineRate === null) return null;
  const lift = relativeLift(observed, baselineRate);
  if (lift === null) return null;
  const prior = baselinePrior(baselineRate, input.policy.priorStrength);
  const bucketPost = updateBeta(prior, input.bucket.clicks, input.bucket.impressions);
  const baselinePost = updateBeta(jeffreysPrior(), input.baseline.clicks, input.baseline.impressions);
  const pBeat = probabilityGreater(bucketPost, baselinePost);
  const interval = liftInterval(bucketPost, baselinePost);
  return {
    organizationId: input.organizationId,
    brandId: input.brandId,
    attribute: input.attribute,
    value: input.value,
    metric: "ctr",
    lift: round4(lift),
    observed: round4(observed),
    baseline: round4(baselineRate),
    pBeat: round4(pBeat),
    ciLow: round4(interval.low),
    ciHigh: round4(interval.high),
    bucket: input.bucket,
    summary: ctrSummary(input.attribute, input.value, observed, baselineRate, lift, pBeat, interval.low, interval.high, input.bucket),
  };
}

function liftInterval(bucket: BetaParams, baseline: BetaParams): { low: number; high: number } {
  const baseMean = betaMean(baseline);
  if (baseMean <= 1e-9) return { low: 0, high: 0 };
  const bucketInterval = betaInterval(bucket);
  return {
    low: (bucketInterval.low - baseMean) / baseMean,
    high: (bucketInterval.high - baseMean) / baseMean,
  };
}

function cvrCandidate(input: {
  organizationId: string;
  brandId: string;
  attribute: string;
  value: string;
  bucket: Totals;
  baseline: Totals;
  policy: Policy;
}): Candidate | null {
  if (input.bucket.clicks < 20 || input.baseline.clicks < 20) return null;
  const observed = rate(input.bucket.conversions, input.bucket.clicks);
  const baselineRate = rate(input.baseline.conversions, input.baseline.clicks);
  if (observed === null || baselineRate === null || baselineRate <= 0) return null;
  const lift = relativeLift(observed, baselineRate);
  if (lift === null) return null;
  const prior = baselinePrior(baselineRate, input.policy.priorStrength);
  const bucketPost = updateBeta(prior, input.bucket.conversions, input.bucket.clicks);
  const baselinePost = updateBeta(jeffreysPrior(), input.baseline.conversions, input.baseline.clicks);
  const pBeat = probabilityGreater(bucketPost, baselinePost);
  const interval = liftInterval(bucketPost, baselinePost);
  return {
    organizationId: input.organizationId,
    brandId: input.brandId,
    attribute: input.attribute,
    value: input.value,
    metric: "cvr",
    lift: round4(lift),
    observed: round4(observed),
    baseline: round4(baselineRate),
    pBeat: round4(pBeat),
    ciLow: round4(interval.low),
    ciHigh: round4(interval.high),
    bucket: input.bucket,
    summary: `${input.attribute}=${input.value}: conversion rate ${(observed * 100).toFixed(1)}% vs baseline ${(baselineRate * 100).toFixed(1)}% (P(beat)=${pBeat.toFixed(2)}, 95% CI lift [${interval.low.toFixed(2)}, ${interval.high.toFixed(2)}], n=${input.bucket.creativeIds.size}).`,
  };
}

function roasCandidate(input: {
  organizationId: string;
  brandId: string;
  attribute: string;
  value: string;
  bucket: Totals;
  baseline: Totals;
}): Candidate | null {
  if (input.bucket.spendCents < 1000 || input.baseline.spendCents < 3000) return null;
  const observed = rate(input.bucket.revenueCents, input.bucket.roasSpend);
  const baselineRate = rate(input.baseline.revenueCents, input.baseline.roasSpend);
  if (observed === null || baselineRate === null || baselineRate <= 0) return null;
  const lift = relativeLift(observed, baselineRate);
  if (lift === null) return null;
  // ROAS is not binomial. Report lift with a spend-weighted interval, not a fake P(beat).
  const spendShare = input.bucket.spendCents / Math.max(1, input.baseline.spendCents);
  const width = Math.max(0.05, 0.4 / Math.sqrt(Math.max(1, spendShare * 20)));
  const pBeat = lift > 0 ? Math.min(0.99, 0.5 + lift / (2 * width + Math.abs(lift))) : Math.max(0.01, 0.5 + lift / (2 * width + Math.abs(lift)));
  return {
    organizationId: input.organizationId,
    brandId: input.brandId,
    attribute: input.attribute,
    value: input.value,
    metric: "roas",
    lift: round4(lift),
    observed: round4(observed),
    baseline: round4(baselineRate),
    pBeat: round4(pBeat),
    ciLow: round4(lift - width),
    ciHigh: round4(lift + width),
    bucket: input.bucket,
    summary: `${input.attribute}=${input.value}: ROAS ${observed.toFixed(2)} vs baseline ${baselineRate.toFixed(2)} (P(beat)=${pBeat.toFixed(2)}, 95% CI lift [${(lift - width).toFixed(2)}, ${(lift + width).toFixed(2)}], n=${input.bucket.creativeIds.size}, spend ${input.bucket.spendCents} cents).`,
  };
}

function toPattern(candidate: Candidate, qValue: number, policy: Policy): LearnedPattern {
  return {
    organizationId: candidate.organizationId,
    brandId: candidate.brandId,
    scope: "brand",
    attribute: candidate.attribute,
    value: candidate.value,
    metric: candidate.metric,
    lift: candidate.lift,
    sampleSize: candidate.bucket.creativeIds.size,
    baseline: candidate.baseline,
    observed: candidate.observed,
    impressions: candidate.bucket.impressions,
    clicks: candidate.bucket.clicks,
    conversions: candidate.bucket.conversions,
    spendCents: candidate.bucket.spendCents,
    revenueCents: candidate.bucket.revenueCents,
    state: learningState(candidate.bucket.creativeIds.size, candidate.bucket.impressions, candidate.pBeat, policy),
    summary: `${candidate.summary} BH q=${qValue.toFixed(3)}.`,
    pBeat: candidate.pBeat,
    ciLow: candidate.ciLow,
    ciHigh: candidate.ciHigh,
    qValue: round4(qValue),
  };
}

type OrganicTotals = {
  views: number;
  threeSecondViews: number;
  completionSum: number;
  completionCount: number;
  shares: number;
  creativeIds: Set<string>;
};

function emptyOrganicTotals(): OrganicTotals {
  return {
    views: 0,
    threeSecondViews: 0,
    completionSum: 0,
    completionCount: 0,
    shares: 0,
    creativeIds: new Set(),
  };
}

function addOrganic(totals: OrganicTotals, row: OrganicObservationRow): void {
  if (row.views != null) totals.views += row.views;
  if (row.threeSecondViews != null) totals.threeSecondViews += row.threeSecondViews;
  if (row.completionRate != null) {
    totals.completionSum += row.completionRate;
    totals.completionCount += 1;
  }
  if (row.shares != null) totals.shares += row.shares;
  totals.creativeIds.add(row.creativeId);
}

function retentionCandidate(input: {
  organizationId: string;
  brandId: string;
  attribute: string;
  value: string;
  bucket: OrganicTotals;
  baseline: OrganicTotals;
  policy: Policy;
}): Candidate | null {
  if (input.bucket.views < 20 || input.baseline.views < 40) return null;
  const observed = rate(input.bucket.threeSecondViews, input.bucket.views);
  const baselineRate = rate(input.baseline.threeSecondViews, input.baseline.views);
  if (observed === null || baselineRate === null || baselineRate <= 0) return null;
  const lift = relativeLift(observed, baselineRate);
  if (lift === null) return null;
  const prior = baselinePrior(baselineRate, input.policy.priorStrength);
  const bucketPost = updateBeta(prior, input.bucket.threeSecondViews, input.bucket.views);
  const baselinePost = updateBeta(jeffreysPrior(), input.baseline.threeSecondViews, input.baseline.views);
  const pBeat = probabilityGreater(bucketPost, baselinePost);
  const interval = liftInterval(bucketPost, baselinePost);
  return {
    organizationId: input.organizationId,
    brandId: input.brandId,
    attribute: input.attribute,
    value: input.value,
    metric: "retention_3s",
    lift: round4(lift),
    observed: round4(observed),
    baseline: round4(baselineRate),
    pBeat: round4(pBeat),
    ciLow: round4(interval.low),
    ciHigh: round4(interval.high),
    bucket: {
      impressions: input.bucket.views,
      clicks: input.bucket.threeSecondViews,
      conversions: 0,
      spendCents: 0,
      revenueCents: 0,
      roasSpend: 0,
      creativeIds: input.bucket.creativeIds,
    },
    summary: `${input.attribute}=${input.value}: 3s retention ${(observed * 100).toFixed(1)}% vs baseline ${(baselineRate * 100).toFixed(1)}% (P(beat)=${pBeat.toFixed(2)}, 95% CI lift [${interval.low.toFixed(2)}, ${interval.high.toFixed(2)}], n=${input.bucket.creativeIds.size}, views=${input.bucket.views}).`,
  };
}

function sharesCandidate(input: {
  organizationId: string;
  brandId: string;
  attribute: string;
  value: string;
  bucket: OrganicTotals;
  baseline: OrganicTotals;
  policy: Policy;
}): Candidate | null {
  if (input.bucket.views < 20 || input.baseline.views < 40) return null;
  const observed = rate(input.bucket.shares, input.bucket.views);
  const baselineRate = rate(input.baseline.shares, input.baseline.views);
  if (observed === null || baselineRate === null || baselineRate <= 0) return null;
  const lift = relativeLift(observed, baselineRate);
  if (lift === null) return null;
  const prior = baselinePrior(baselineRate, input.policy.priorStrength);
  const bucketPost = updateBeta(prior, input.bucket.shares, input.bucket.views);
  const baselinePost = updateBeta(jeffreysPrior(), input.baseline.shares, input.baseline.views);
  const pBeat = probabilityGreater(bucketPost, baselinePost);
  const interval = liftInterval(bucketPost, baselinePost);
  return {
    organizationId: input.organizationId,
    brandId: input.brandId,
    attribute: input.attribute,
    value: input.value,
    metric: "shares",
    lift: round4(lift),
    observed: round4(observed),
    baseline: round4(baselineRate),
    pBeat: round4(pBeat),
    ciLow: round4(interval.low),
    ciHigh: round4(interval.high),
    bucket: {
      impressions: input.bucket.views,
      clicks: 0,
      conversions: input.bucket.shares,
      spendCents: 0,
      revenueCents: 0,
      roasSpend: 0,
      creativeIds: input.bucket.creativeIds,
    },
    summary: `${input.attribute}=${input.value}: share rate ${(observed * 100).toFixed(2)}% vs baseline ${(baselineRate * 100).toFixed(2)}% (P(beat)=${pBeat.toFixed(2)}, 95% CI lift [${interval.low.toFixed(2)}, ${interval.high.toFixed(2)}], n=${input.bucket.creativeIds.size}, views=${input.bucket.views}).`,
  };
}

function completionCandidate(input: {
  organizationId: string;
  brandId: string;
  attribute: string;
  value: string;
  bucket: OrganicTotals;
  baseline: OrganicTotals;
  policy: Policy;
}): Candidate | null {
  if (input.bucket.completionCount < 1 || input.baseline.completionCount < 2) return null;
  const observed = input.bucket.completionSum / input.bucket.completionCount;
  const baselineRate = input.baseline.completionSum / input.baseline.completionCount;
  if (baselineRate <= 0) return null;
  const lift = relativeLift(observed, baselineRate);
  if (lift === null) return null;
  const width = Math.max(0.04, 0.3 / Math.sqrt(Math.max(1, input.bucket.completionCount * 2)));
  const pBeat = lift > 0 ? Math.min(0.99, 0.5 + lift / (2 * width + Math.abs(lift))) : Math.max(0.01, 0.5 + lift / (2 * width + Math.abs(lift)));
  return {
    organizationId: input.organizationId,
    brandId: input.brandId,
    attribute: input.attribute,
    value: input.value,
    metric: "completion_rate",
    lift: round4(lift),
    observed: round4(observed),
    baseline: round4(baselineRate),
    pBeat: round4(pBeat),
    ciLow: round4(lift - width),
    ciHigh: round4(lift + width),
    bucket: {
      impressions: input.bucket.views,
      clicks: 0,
      conversions: 0,
      spendCents: 0,
      revenueCents: 0,
      roasSpend: 0,
      creativeIds: input.bucket.creativeIds,
    },
    summary: `${input.attribute}=${input.value}: completion rate ${(observed * 100).toFixed(1)}% vs baseline ${(baselineRate * 100).toFixed(1)}% (P(beat)=${pBeat.toFixed(2)}, 95% CI lift [${(lift - width).toFixed(2)}, ${(lift + width).toFixed(2)}], n=${input.bucket.creativeIds.size}).`,
  };
}

/**
 * Aggregate stored observations. A bucket is kept when the beta-binomial
 * posterior says it beats (or loses to) the brand baseline after a multiple-
 * testing correction. Nothing here is a canned lift.
 */
export function learnPatterns(
  input: {
    organizationId: string;
    brandId: string;
    creatives: ObservedCreative[];
    observations: PerformanceRow[];
    organicObservations?: OrganicObservationRow[];
  },
  policy = DEFAULT_LEARNING_POLICY,
): LearnedPattern[] {
  assertSameTenant(input.creatives, input.organizationId, input.brandId);
  assertSameTenant(input.observations, input.organizationId, input.brandId);
  if (input.organicObservations) {
    assertSameTenant(input.organicObservations, input.organizationId, input.brandId);
  }
  const byId = new Map(input.creatives.map((creative) => [creative.id, creative]));
  const totalsByCreative = new Map<string, PerformanceRow>();
  for (const row of input.observations) {
    if (!byId.has(row.creativeId)) continue;
    const current = totalsByCreative.get(row.creativeId) ?? {
      creativeId: row.creativeId,
      organizationId: row.organizationId,
      brandId: row.brandId,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      spendCents: 0,
      revenueCents: 0,
    };
    current.impressions += row.impressions;
    current.clicks += row.clicks;
    current.conversions += row.conversions;
    current.spendCents += row.spendCents;
    if (row.revenueCents == null) current.revenueCents = null;
    else if (current.revenueCents != null) current.revenueCents += row.revenueCents;
    totalsByCreative.set(row.creativeId, current);
  }

  const baseline = emptyTotals();
  for (const row of totalsByCreative.values()) add(baseline, row);

  const organicTotalsByCreative = new Map<string, OrganicObservationRow>();
  if (input.organicObservations) {
    for (const row of input.organicObservations) {
      if (!byId.has(row.creativeId)) continue;
      const current = organicTotalsByCreative.get(row.creativeId) ?? {
        creativeId: row.creativeId,
        organizationId: row.organizationId,
        brandId: row.brandId,
        views: null,
        threeSecondViews: null,
        completionRate: null,
        shares: null,
        likes: null,
        comments: null,
      };
      if (row.views != null) current.views = (current.views ?? 0) + row.views;
      if (row.threeSecondViews != null) current.threeSecondViews = (current.threeSecondViews ?? 0) + row.threeSecondViews;
      if (row.completionRate != null) current.completionRate = row.completionRate;
      if (row.shares != null) current.shares = (current.shares ?? 0) + row.shares;
      if (row.likes != null) current.likes = (current.likes ?? 0) + row.likes;
      if (row.comments != null) current.comments = (current.comments ?? 0) + row.comments;
      organicTotalsByCreative.set(row.creativeId, current);
    }
  }

  const organicBaseline = emptyOrganicTotals();
  for (const row of organicTotalsByCreative.values()) addOrganic(organicBaseline, row);

  if (baseline.impressions <= 0 && organicBaseline.views <= 0) return [];

  const candidates: Candidate[] = [];
  const emit = (attribute: string, valueOf: (creative: ObservedCreative) => string) => {
    if (baseline.impressions > 0) {
      const buckets = new Map<string, Totals>();
      for (const row of totalsByCreative.values()) {
        const creative = byId.get(row.creativeId);
        if (!creative) continue;
        const value = valueOf(creative).trim().toLowerCase();
        if (!value || value === "+" || value.startsWith("+") || value.endsWith("+")) continue;
        const bucket = buckets.get(value) ?? emptyTotals();
        add(bucket, row);
        buckets.set(value, bucket);
      }
      if (buckets.size >= 2) {
        for (const [value, bucket] of buckets) {
          if (bucket.creativeIds.size < 1 || bucket.impressions < 1) continue;
          const shared = {
            organizationId: input.organizationId,
            brandId: input.brandId,
            attribute,
            value,
            bucket,
            baseline,
            policy,
          };
          const ctr = ctrCandidate(shared);
          if (ctr) candidates.push(ctr);
          const cvr = cvrCandidate(shared);
          if (cvr) candidates.push(cvr);
          const roas = roasCandidate({ ...shared });
          if (roas) candidates.push(roas);
        }
      }
    }

    if (organicBaseline.views > 0) {
      const organicBuckets = new Map<string, OrganicTotals>();
      for (const row of organicTotalsByCreative.values()) {
        const creative = byId.get(row.creativeId);
        if (!creative) continue;
        const value = valueOf(creative).trim().toLowerCase();
        if (!value || value === "+" || value.startsWith("+") || value.endsWith("+")) continue;
        const bucket = organicBuckets.get(value) ?? emptyOrganicTotals();
        addOrganic(bucket, row);
        organicBuckets.set(value, bucket);
      }
      if (organicBuckets.size >= 2) {
        for (const [value, bucket] of organicBuckets) {
          if (bucket.creativeIds.size < 1 || bucket.views < 1) continue;
          const shared = {
            organizationId: input.organizationId,
            brandId: input.brandId,
            attribute,
            value,
            bucket,
            baseline: organicBaseline,
            policy,
          };
          const retention = retentionCandidate(shared);
          if (retention) candidates.push(retention);
          const shares = sharesCandidate(shared);
          if (shares) candidates.push(shares);
          const completion = completionCandidate(shared);
          if (completion) candidates.push(completion);
        }
      }
    }
  };

  for (const attribute of ATTRIBUTES) {
    emit(attribute, (creative) => creative[attribute]);
  }
  for (const [left, right] of PAIRS) {
    emit(`${left}+${right}`, (creative) => {
      const a = creative[left].trim().toLowerCase();
      const b = creative[right].trim().toLowerCase();
      if (!a || !b) return "";
      return `${a}+${b}`;
    });
  }

  const byMetric = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const list = byMetric.get(candidate.metric) ?? [];
    list.push(candidate);
    byMetric.set(candidate.metric, list);
  }
  const patterns: LearnedPattern[] = [];
  for (const group of byMetric.values()) {
    const qValues = bhQValues(group.map((item) => twoSidedP(item.pBeat)));
    group.forEach((candidate, index) => {
      const qValue = qValues[index] ?? 1;
      const decisive = candidate.pBeat >= policy.minPBeat || candidate.pBeat <= 1 - policy.minPBeat;
      if (!decisive || qValue > policy.fdr) return;
      patterns.push(toPattern(candidate, qValue, policy));
    });
  }

  return patterns.sort((a, b) => Math.abs(b.lift) - Math.abs(a.lift));
}

function ctrSummary(
  attribute: string,
  value: string,
  observed: number,
  baseline: number,
  lift: number,
  pBeat: number,
  ciLow: number,
  ciHigh: number,
  bucket: Totals,
): string {
  return `${attribute}=${value}: CTR ${(observed * 100).toFixed(1)}% vs baseline ${(baseline * 100).toFixed(1)}% (lift ${(lift * 100).toFixed(0)}%, P(beat)=${pBeat.toFixed(2)}, 95% CI [${ciLow.toFixed(2)}, ${ciHigh.toFixed(2)}], n=${bucket.creativeIds.size} creatives, ${bucket.impressions} impressions).`;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function countRejections(reasonCodes: string[]): { reasonCode: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const code of reasonCodes) {
    const key = code.trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reasonCode, count]) => ({ reasonCode, count }))
    .sort((a, b) => b.count - a.count);
}
