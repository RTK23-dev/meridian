import {
  assertSameTenant,
  type LearnedPattern,
  type LearningState,
  type ObservedCreative,
  type PerformanceRow,
} from "../domain.ts";

export const DEFAULT_LEARNING_POLICY = {
  minCreativesPerBucket: 3,
  minImpressionsPerBucket: 300,
  minAbsLift: 0.05,
  /** Below this, a pattern that already met the sample floor stays OBSERVED. */
  inferredMinImpressions: 800,
  /** Validated requires a larger sample. It is not a statistical certificate. */
  validatedMinCreatives: 4,
  validatedMinImpressions: 2000,
  validatedMinAbsLift: 0.15,
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
  absLift: number,
  policy: typeof DEFAULT_LEARNING_POLICY,
): LearningState {
  if (
    sampleSize >= policy.validatedMinCreatives &&
    impressions >= policy.validatedMinImpressions &&
    absLift >= policy.validatedMinAbsLift
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

/** Sample floor first. A small lift is not a direction. */
export function learningDirection(pattern: {
  lift: number;
  sampleSize: number;
  impressions: number;
}): LearningDirection {
  const impressions = Number(pattern.impressions);
  const sampleSize = Number(pattern.sampleSize);
  if (
    !Number.isFinite(sampleSize) ||
    !Number.isFinite(impressions) ||
    sampleSize < DEFAULT_LEARNING_POLICY.minCreativesPerBucket ||
    impressions < DEFAULT_LEARNING_POLICY.minImpressionsPerBucket
  ) {
    return "INSUFFICIENT_EVIDENCE";
  }
  if (!Number.isFinite(pattern.lift) || Math.abs(pattern.lift) < DEFAULT_LEARNING_POLICY.minAbsLift) return "NEUTRAL";
  if (pattern.lift > 0) return "POSITIVE";
  return "NEGATIVE";
}

type Policy = typeof DEFAULT_LEARNING_POLICY;

function pushMetrics(
  patterns: LearnedPattern[],
  input: {
    organizationId: string;
    brandId: string;
    attribute: string;
    value: string;
    bucket: Totals;
    baseline: Totals;
    baselineCtr: number;
    policy: Policy;
  },
): void {
  const { bucket, baseline, policy } = input;
  const observedCtr = rate(bucket.clicks, bucket.impressions);
  if (observedCtr !== null && input.baselineCtr !== 0) {
    const lift = (observedCtr - input.baselineCtr) / input.baselineCtr;
    if (Math.abs(lift) >= policy.minAbsLift) {
      patterns.push(
        patternRow(input, "ctr", lift, observedCtr, input.baselineCtr, ctrSummary(input.attribute, input.value, observedCtr, input.baselineCtr, lift, bucket)),
      );
    }
  }
  const observedCvr = rate(bucket.conversions, bucket.clicks);
  const baselineCvr = rate(baseline.conversions, baseline.clicks);
  if (observedCvr !== null && baselineCvr !== null && baselineCvr > 0 && bucket.clicks >= 50 && baseline.clicks >= 50) {
    const cvrLift = (observedCvr - baselineCvr) / baselineCvr;
    if (Math.abs(cvrLift) >= policy.minAbsLift) {
      patterns.push(
        patternRow(
          input,
          "cvr",
          cvrLift,
          observedCvr,
          baselineCvr,
          `${input.attribute}=${input.value}: conversion rate ${(observedCvr * 100).toFixed(1)}% vs baseline ${(baselineCvr * 100).toFixed(1)}% (lift ${(cvrLift * 100).toFixed(0)}%, n=${bucket.creativeIds.size}).`,
        ),
      );
    }
  }
  const observedRoas = rate(bucket.revenueCents, bucket.roasSpend);
  const baselineRoas = rate(baseline.revenueCents, baseline.roasSpend);
  if (
    observedRoas !== null &&
    baselineRoas !== null &&
    baselineRoas > 0 &&
    bucket.spendCents >= 1000 &&
    baseline.spendCents >= 3000
  ) {
    const roasLift = (observedRoas - baselineRoas) / baselineRoas;
    if (Math.abs(roasLift) >= policy.minAbsLift) {
      patterns.push(
        patternRow(
          input,
          "roas",
          roasLift,
          observedRoas,
          baselineRoas,
          `${input.attribute}=${input.value}: ROAS ${observedRoas.toFixed(2)} vs baseline ${baselineRoas.toFixed(2)} (lift ${(roasLift * 100).toFixed(0)}%, n=${bucket.creativeIds.size}, spend ${bucket.spendCents} cents).`,
        ),
      );
    }
  }
}

function patternRow(
  input: {
    organizationId: string;
    brandId: string;
    attribute: string;
    value: string;
    bucket: Totals;
    policy: Policy;
  },
  metric: LearnedPattern["metric"],
  lift: number,
  observed: number,
  baseline: number,
  summary: string,
): LearnedPattern {
  return {
    organizationId: input.organizationId,
    brandId: input.brandId,
    scope: "brand",
    attribute: input.attribute,
    value: input.value,
    metric,
    lift: round4(lift),
    sampleSize: input.bucket.creativeIds.size,
    baseline: round4(baseline),
    observed: round4(observed),
    impressions: input.bucket.impressions,
    clicks: input.bucket.clicks,
    conversions: input.bucket.conversions,
    spendCents: input.bucket.spendCents,
    revenueCents: input.bucket.revenueCents,
    state: learningState(input.bucket.creativeIds.size, input.bucket.impressions, Math.abs(lift), input.policy),
    summary,
  };
}

/**
 * Aggregate stored observations. Patterns are withheld until the sample
 * policy is met. Pair attributes use the same floor. Nothing here is a canned lift.
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
    if (row.revenueCents == null) current.revenueCents = null;
    else if (current.revenueCents != null) current.revenueCents += row.revenueCents;
    totalsByCreative.set(row.creativeId, current);
  }

  const baseline = emptyTotals();
  for (const row of totalsByCreative.values()) add(baseline, row);
  const baselineCtr = rate(baseline.clicks, baseline.impressions);
  if (baselineCtr === null || baseline.impressions < policy.minImpressionsPerBucket) return [];

  const patterns: LearnedPattern[] = [];
  const emit = (attribute: string, valueOf: (creative: ObservedCreative) => string) => {
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
    for (const [value, bucket] of buckets) {
      if (bucket.creativeIds.size < policy.minCreativesPerBucket) continue;
      if (bucket.impressions < policy.minImpressionsPerBucket) continue;
      pushMetrics(patterns, {
        organizationId: input.organizationId,
        brandId: input.brandId,
        attribute,
        value,
        bucket,
        baseline,
        baselineCtr,
        policy,
      });
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
