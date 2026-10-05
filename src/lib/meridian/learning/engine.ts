import { assertSameTenant, type LearnedPattern, type ObservedCreative, type PerformanceRow } from "../domain.ts";

export const DEFAULT_LEARNING_POLICY = {
  minCreativesPerBucket: 3,
  minImpressionsPerBucket: 300,
  minAbsLift: 0.05,
};

const ATTRIBUTES = ["angle", "hookType", "format", "proofType", "visualStyle", "platform", "offer", "cta"] as const;

type Totals = {
  impressions: number;
  clicks: number;
  conversions: number;
  spendCents: number;
  revenueCents: number;
  creativeIds: Set<string>;
};

function emptyTotals(): Totals {
  return {
    impressions: 0,
    clicks: 0,
    conversions: 0,
    spendCents: 0,
    revenueCents: 0,
    creativeIds: new Set(),
  };
}

function add(totals: Totals, row: PerformanceRow): void {
  totals.impressions += row.impressions;
  totals.clicks += row.clicks;
  totals.conversions += row.conversions;
  totals.spendCents += row.spendCents;
  totals.revenueCents += row.revenueCents;
  totals.creativeIds.add(row.creativeId);
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

/**
 * Aggregate stored observations. Patterns are withheld until the sample
 * policy is met. Nothing here is a canned lift.
 */
export function learnPatterns(
  input: {
    organizationId: string;
    brandId: string;
    creatives: ObservedCreative[];
    observations: PerformanceRow[];
  },
  policy = DEFAULT_LEARNING_POLICY,
): LearnedPattern[] {
  assertSameTenant(input.creatives, input.organizationId, input.brandId);
  assertSameTenant(input.observations, input.organizationId, input.brandId);
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
    current.revenueCents += row.revenueCents;
    totalsByCreative.set(row.creativeId, current);
  }

  const baseline = emptyTotals();
  for (const row of totalsByCreative.values()) add(baseline, row);
  const baselineCtr = rate(baseline.clicks, baseline.impressions);
  if (baselineCtr === null || baseline.impressions < policy.minImpressionsPerBucket) return [];

  const patterns: LearnedPattern[] = [];
  for (const attribute of ATTRIBUTES) {
    const buckets = new Map<string, Totals>();
    for (const row of totalsByCreative.values()) {
      const creative = byId.get(row.creativeId);
      if (!creative) continue;
      const value = creative[attribute].trim();
      if (!value) continue;
      const bucket = buckets.get(value.toLowerCase()) ?? emptyTotals();
      add(bucket, row);
      buckets.set(value.toLowerCase(), bucket);
    }
    for (const [value, bucket] of buckets) {
      if (bucket.creativeIds.size < policy.minCreativesPerBucket) continue;
      if (bucket.impressions < policy.minImpressionsPerBucket) continue;
      const observedCtr = rate(bucket.clicks, bucket.impressions);
      if (observedCtr !== null && baselineCtr !== 0) {
        const lift = (observedCtr - baselineCtr) / baselineCtr;
        if (Math.abs(lift) >= policy.minAbsLift) {
          patterns.push({
            attribute,
            value,
            metric: "ctr",
            lift: round4(lift),
            sampleSize: bucket.creativeIds.size,
            baseline: round4(baselineCtr),
            observed: round4(observedCtr),
            impressions: bucket.impressions,
            summary: ctrSummary(attribute, value, observedCtr, baselineCtr, lift, bucket),
          });
        }
      }
      const observedCvr = rate(bucket.conversions, bucket.clicks);
      const baselineCvr = rate(baseline.conversions, baseline.clicks);
      if (
        observedCvr !== null &&
        baselineCvr !== null &&
        baselineCvr > 0 &&
        bucket.clicks >= 50 &&
        baseline.clicks >= 50
      ) {
        const cvrLift = (observedCvr - baselineCvr) / baselineCvr;
        if (Math.abs(cvrLift) >= policy.minAbsLift) {
          patterns.push({
            attribute,
            value,
            metric: "cvr",
            lift: round4(cvrLift),
            sampleSize: bucket.creativeIds.size,
            baseline: round4(baselineCvr),
            observed: round4(observedCvr),
            impressions: bucket.impressions,
            summary: `${attribute}=${value}: conversion rate ${(observedCvr * 100).toFixed(1)}% vs baseline ${(baselineCvr * 100).toFixed(1)}% (lift ${(cvrLift * 100).toFixed(0)}%, n=${bucket.creativeIds.size}).`,
          });
        }
      }
      const observedRoas = rate(bucket.revenueCents, bucket.spendCents);
      const baselineRoas = rate(baseline.revenueCents, baseline.spendCents);
      if (
        observedRoas !== null &&
        baselineRoas !== null &&
        baselineRoas > 0 &&
        bucket.spendCents >= 1000 &&
        baseline.spendCents >= 3000
      ) {
        const roasLift = (observedRoas - baselineRoas) / baselineRoas;
        if (Math.abs(roasLift) >= policy.minAbsLift) {
          patterns.push({
            attribute,
            value,
            metric: "roas",
            lift: round4(roasLift),
            sampleSize: bucket.creativeIds.size,
            baseline: round4(baselineRoas),
            observed: round4(observedRoas),
            impressions: bucket.impressions,
            summary: `${attribute}=${value}: ROAS ${observedRoas.toFixed(2)} vs baseline ${baselineRoas.toFixed(2)} (lift ${(roasLift * 100).toFixed(0)}%, n=${bucket.creativeIds.size}, spend ${bucket.spendCents} cents).`,
          });
        }
      }
    }
  }
  return patterns.sort((a, b) => Math.abs(b.lift) - Math.abs(a.lift));
}

function ctrSummary(
  attribute: string,
  value: string,
  observed: number,
  baseline: number,
  lift: number,
  bucket: Totals,
): string {
  return `${attribute}=${value}: CTR ${(observed * 100).toFixed(1)}% vs baseline ${(baseline * 100).toFixed(1)}% (lift ${(lift * 100).toFixed(0)}%, n=${bucket.creativeIds.size} creatives, ${bucket.impressions} impressions).`;
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
