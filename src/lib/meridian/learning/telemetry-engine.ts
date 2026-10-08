/**
 * Unified Performance Telemetry & Closed-Loop Bayesian Flywheel Engine
 *
 * Ingests multi-channel performance telemetry across organic social posts and paid ads,
 * applies exponential recency decay, computes Bayesian feature posteriors, and closes
 * the loop back into JEV account profiles and pattern databases.
 *
 * Adheres strictly to tenant isolation and does not invent unobserved metrics.
 */

import { randomUUID } from "node:crypto";
import type { Sql } from "./store.ts";
import {
  calculateDecayWeight,
  updateBetaWeighted,
  baselinePrior,
  betaMean,
  betaInterval,
  probabilityGreater,
  type BetaParams,
} from "../stats/beta.ts";
import { applyLearnedPatterns } from "./store.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TelemetrySourceType = "organic" | "paid" | "hybrid";

export type TelemetryRecordInput = {
  id?: string;
  organizationId: string;
  brandId: string;
  publishJobId?: string | null;
  accountId?: string | null;
  platform: string;
  sourceType?: TelemetrySourceType;
  creativeId?: string;
  variantId?: string;
  externalPostId?: string;
  hookType?: string;
  angle?: string;
  format?: string;
  views?: number | null;
  impressions?: number | null;
  reach?: number | null;
  clicks?: number | null;
  engagements?: number | null;
  shares?: number | null;
  saves?: number | null;
  conversions?: number | null;
  spendCents?: number | null;
  revenueCents?: number | null;
  watchTimeSeconds?: number | null;
  hookRetention3s?: number | null;
  completionRate?: number | null;
  recordedAt?: string | Date;
  metadata?: Record<string, any>;
};

export type TelemetryRecord = {
  id: string;
  organizationId: string;
  brandId: string;
  publishJobId: string | null;
  accountId: string | null;
  platform: string;
  sourceType: TelemetrySourceType;
  creativeId: string;
  variantId: string;
  externalPostId: string;
  hookType: string;
  angle: string;
  format: string;
  views: number | null;
  impressions: number | null;
  reach: number | null;
  clicks: number | null;
  engagements: number | null;
  shares: number | null;
  saves: number | null;
  conversions: number | null;
  spendCents: number | null;
  revenueCents: number | null;
  watchTimeSeconds: number | null;
  hookRetention3s: number | null;
  completionRate: number | null;
  decayWeight: number;
  recordedAt: string;
  createdAt: string;
  metadata: Record<string, any>;
};

export type FeaturePosterior = {
  featureName: string;
  featureValue: string;
  sampleCount: number;
  effectiveTrials: number;
  effectiveSuccesses: number;
  prior: BetaParams;
  posterior: BetaParams & { mean: number };
  credibleInterval90: { low: number; high: number };
  baselineRate: number;
  lift: number;
  probabilityBeatsBaseline: number;
};

export type TelemetrySummary = {
  totalRecords: number;
  totalViews: number;
  totalImpressions: number;
  totalClicks: number;
  totalConversions: number;
  totalSpendCents: number;
  totalRevenueCents: number;
  avgHookRetention3s: number;
  avgCompletionRate: number;
  avgEngagementRate: number;
  byPlatform: Record<string, { views: number; engagements: number; shares: number }>;
  posteriorsByHookType: FeaturePosterior[];
  posteriorsByAngle: FeaturePosterior[];
};

export type TelemetrySyncResult = {
  syncedRecords: number;
  patternsLearned: number;
  topHooks: string[];
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Telemetry Ingestion
// ---------------------------------------------------------------------------

/**
 * Persists a single unified telemetry record, automatically computing its recency-decay weight.
 */
export async function recordTelemetry(
  sql: Sql,
  input: TelemetryRecordInput,
  halfLifeDays = 14,
): Promise<TelemetryRecord> {
  if (!input.organizationId || !input.brandId) {
    throw new Error("Telemetry record requires organizationId and brandId.");
  }

  const isSynthetic =
    input.metadata?.synthetic === true ||
    input.metadata?.simulated === true ||
    (input as any).synthetic === true ||
    (input as any).simulated === true;

  if (isSynthetic) {
    if (process.env.NODE_ENV === "production" || process.env.ALLOW_SYNTHETIC_TELEMETRY !== "true") {
      throw new Error("Synthetic or simulated telemetry cannot be ingested into production learning.");
    }
  }

  const id = input.id || randomUUID();
  const recordedAtDate = input.recordedAt ? new Date(input.recordedAt) : new Date();
  const recordedAtMs = recordedAtDate.getTime();
  const decayWeight = calculateDecayWeight(recordedAtMs, Date.now(), halfLifeDays);

  const safeViews = input.views != null ? Math.max(0, Math.floor(input.views)) : null;
  const safeImpressions = input.impressions != null ? Math.max(0, Math.floor(input.impressions)) : null;
  const safeReach = input.reach != null ? Math.max(0, Math.floor(input.reach)) : null;
  const safeClicks = input.clicks != null ? Math.max(0, Math.floor(input.clicks)) : null;
  const safeEngagements = input.engagements != null ? Math.max(0, Math.floor(input.engagements)) : null;
  const safeShares = input.shares != null ? Math.max(0, Math.floor(input.shares)) : null;
  const safeSaves = input.saves != null ? Math.max(0, Math.floor(input.saves)) : null;
  const safeConversions = input.conversions != null ? Math.max(0, Math.floor(input.conversions)) : null;
  const safeSpendCents = input.spendCents != null ? Math.max(0, Math.floor(input.spendCents)) : null;
  const safeRevenueCents = input.revenueCents != null ? Math.max(0, Math.floor(input.revenueCents)) : null;
  const safeWatchTime = input.watchTimeSeconds != null ? Math.max(0, Math.floor(input.watchTimeSeconds)) : null;
  const safeHookRetention = input.hookRetention3s != null ? Math.min(1, Math.max(0, Number(input.hookRetention3s))) : null;
  const safeCompletionRate = input.completionRate != null ? Math.min(1, Math.max(0, Number(input.completionRate))) : null;

  const metadataJson = JSON.stringify(input.metadata || {});

  await sql`
    insert into unified_performance_telemetry (
      id, organization_id, brand_id, publish_job_id, account_id, platform, source_type,
      creative_id, variant_id, external_post_id, hook_type, angle, format,
      views, impressions, reach, clicks, engagements, shares, saves, conversions,
      spend_cents, revenue_cents, watch_time_seconds, hook_retention_3s, completion_rate,
      decay_weight, recorded_at, metadata
    ) values (
      ${id}, ${input.organizationId}, ${input.brandId}, ${input.publishJobId ?? null},
      ${input.accountId ?? null}, ${input.platform}, ${input.sourceType ?? "organic"},
      ${input.creativeId ?? ""}, ${input.variantId ?? ""}, ${input.externalPostId ?? ""},
      ${input.hookType ?? ""}, ${input.angle ?? ""}, ${input.format ?? ""},
      ${safeViews}, ${safeImpressions}, ${safeReach}, ${safeClicks}, ${safeEngagements},
      ${safeShares}, ${safeSaves}, ${safeConversions}, ${safeSpendCents}, ${safeRevenueCents},
      ${safeWatchTime}, ${safeHookRetention}, ${safeCompletionRate},
      ${decayWeight}, ${recordedAtDate.toISOString()}, ${metadataJson}
    )
  `;

  return {
    id,
    organizationId: input.organizationId,
    brandId: input.brandId,
    publishJobId: input.publishJobId ?? null,
    accountId: input.accountId ?? null,
    platform: input.platform,
    sourceType: input.sourceType ?? "organic",
    creativeId: input.creativeId ?? "",
    variantId: input.variantId ?? "",
    externalPostId: input.externalPostId ?? "",
    hookType: input.hookType ?? "",
    angle: input.angle ?? "",
    format: input.format ?? "",
    views: safeViews,
    impressions: safeImpressions,
    reach: safeReach,
    clicks: safeClicks,
    engagements: safeEngagements,
    shares: safeShares,
    saves: safeSaves,
    conversions: safeConversions,
    spendCents: safeSpendCents,
    revenueCents: safeRevenueCents,
    watchTimeSeconds: safeWatchTime,
    hookRetention3s: safeHookRetention,
    completionRate: safeCompletionRate,
    decayWeight,
    recordedAt: recordedAtDate.toISOString(),
    createdAt: new Date().toISOString(),
    metadata: input.metadata || {},
  };
}

/**
 * Ingests a batch of telemetry records.
 */
export async function recordBatchTelemetry(
  sql: Sql,
  records: TelemetryRecordInput[],
  halfLifeDays = 14,
): Promise<TelemetryRecord[]> {
  const results: TelemetryRecord[] = [];
  for (const record of records) {
    const res = await recordTelemetry(sql, record, halfLifeDays);
    results.push(res);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Telemetry Querying
// ---------------------------------------------------------------------------

export async function getTelemetryRecords(
  sql: Sql,
  organizationId: string,
  brandId: string,
  filters?: {
    platform?: string;
    sourceType?: TelemetrySourceType;
    creativeId?: string;
    limit?: number;
  },
): Promise<TelemetryRecord[]> {
  const limit = Math.min(500, Math.max(1, filters?.limit ?? 100));

  let rows: any[];
  if (filters?.platform && filters?.sourceType) {
    rows = await sql`
      select * from unified_performance_telemetry
      where organization_id = ${organizationId}
        and brand_id = ${brandId}
        and platform = ${filters.platform}
        and source_type = ${filters.sourceType}
      order by recorded_at desc
      limit ${limit}
    `;
  } else if (filters?.platform) {
    rows = await sql`
      select * from unified_performance_telemetry
      where organization_id = ${organizationId}
        and brand_id = ${brandId}
        and platform = ${filters.platform}
      order by recorded_at desc
      limit ${limit}
    `;
  } else if (filters?.creativeId) {
    rows = await sql`
      select * from unified_performance_telemetry
      where organization_id = ${organizationId}
        and brand_id = ${brandId}
        and creative_id = ${filters.creativeId}
      order by recorded_at desc
      limit ${limit}
    `;
  } else {
    rows = await sql`
      select * from unified_performance_telemetry
      where organization_id = ${organizationId}
        and brand_id = ${brandId}
      order by recorded_at desc
      limit ${limit}
    `;
  }

  return (rows || []).map(mapRowToTelemetryRecord);
}

function mapRowToTelemetryRecord(r: any): TelemetryRecord {
  return {
    id: String(r.id),
    organizationId: String(r.organization_id),
    brandId: String(r.brand_id),
    publishJobId: r.publish_job_id ? String(r.publish_job_id) : null,
    accountId: r.account_id ? String(r.account_id) : null,
    platform: String(r.platform),
    sourceType: (r.source_type as TelemetrySourceType) || "organic",
    creativeId: String(r.creative_id || ""),
    variantId: String(r.variant_id || ""),
    externalPostId: String(r.external_post_id || ""),
    hookType: String(r.hook_type || ""),
    angle: String(r.angle || ""),
    format: String(r.format || ""),
    views: r.views != null ? Number(r.views) : null,
    impressions: r.impressions != null ? Number(r.impressions) : null,
    reach: r.reach != null ? Number(r.reach) : null,
    clicks: r.clicks != null ? Number(r.clicks) : null,
    engagements: r.engagements != null ? Number(r.engagements) : null,
    shares: r.shares != null ? Number(r.shares) : null,
    saves: r.saves != null ? Number(r.saves) : null,
    conversions: r.conversions != null ? Number(r.conversions) : null,
    spendCents: r.spend_cents != null ? Number(r.spend_cents) : null,
    revenueCents: r.revenue_cents != null ? Number(r.revenue_cents) : null,
    watchTimeSeconds: r.watch_time_seconds != null ? Number(r.watch_time_seconds) : null,
    hookRetention3s: r.hook_retention_3s != null ? Number(r.hook_retention_3s) : null,
    completionRate: r.completion_rate != null ? Number(r.completion_rate) : null,
    decayWeight: Number(r.decay_weight) || 1.0,
    recordedAt: String(r.recorded_at),
    createdAt: String(r.created_at),
    metadata: typeof r.metadata === "object" && r.metadata !== null ? r.metadata : {},
  };
}

// ---------------------------------------------------------------------------
// Bayesian Feature Posteriors & Closed-Loop Intelligence
// ---------------------------------------------------------------------------

/**
 * Computes Bayesian Beta posteriors for creative features (hook types, angles)
 * using recency-decay weighted observations.
 */
export function calculateTelemetryFeaturePosteriors(
  records: TelemetryRecord[],
  featureKey: "hookType" | "angle",
): FeaturePosterior[] {
  if (records.length === 0) return [];

  // 1. Calculate overall baseline rate for hook 3s retention
  let totalBaselineTrials = 0;
  let totalBaselineSuccesses = 0;
  for (const r of records) {
    if (r.views == null || r.views <= 0 || r.hookRetention3s == null) continue;
    const successes = Math.round(r.views * r.hookRetention3s);
    totalBaselineTrials += r.views;
    totalBaselineSuccesses += successes;
  }
  const baselineRate = totalBaselineTrials > 0
    ? totalBaselineSuccesses / totalBaselineTrials
    : 0.25; // Default weak DTC baseline

  const prior = baselinePrior(baselineRate, 10);

  // 2. Group observations by feature value
  const groups = new Map<string, Array<{ successes: number; trials: number; weight: number }>>();

  for (const r of records) {
    const val = r[featureKey];
    if (!val || r.views == null || r.views <= 0 || r.hookRetention3s == null) continue;

    if (!groups.has(val)) {
      groups.set(val, []);
    }
    const successes = Math.round(r.views * r.hookRetention3s);
    groups.get(val)!.push({
      successes,
      trials: r.views,
      weight: r.decayWeight,
    });
  }

  const results: FeaturePosterior[] = [];

  for (const [featureValue, obsList] of groups.entries()) {
    const posteriorParams = updateBetaWeighted(prior, obsList);
    const mean = betaMean(posteriorParams);
    const interval = betaInterval(posteriorParams, 0.90);
    const pBeat = probabilityGreater(posteriorParams, prior);

    let effectiveTrials = 0;
    let effectiveSuccesses = 0;
    for (const obs of obsList) {
      effectiveTrials += obs.trials * obs.weight;
      effectiveSuccesses += obs.successes * obs.weight;
    }

    const lift = baselineRate > 0 ? (mean - baselineRate) / baselineRate : 0;

    results.push({
      featureName: featureKey,
      featureValue,
      sampleCount: obsList.length,
      effectiveTrials: Math.round(effectiveTrials),
      effectiveSuccesses: Math.round(effectiveSuccesses),
      prior,
      posterior: {
        ...posteriorParams,
        mean,
      },
      credibleInterval90: {
        low: interval.low,
        high: interval.high,
      },
      baselineRate,
      lift,
      probabilityBeatsBaseline: pBeat,
    });
  }

  // Sort descending by posterior mean
  results.sort((a, b) => b.posterior.mean - a.posterior.mean);
  return results;
}

/**
 * Builds a high-level summary of all telemetry data with multi-channel breakdown.
 */
export function summarizeTelemetry(records: TelemetryRecord[]): TelemetrySummary {
  let totalViews = 0;
  let totalImpressions = 0;
  let totalClicks = 0;
  let totalConversions = 0;
  let totalSpendCents = 0;
  let totalRevenueCents = 0;
  let sumHookRetention = 0;
  let sumCompletion = 0;
  let retentionSamples = 0;
  let completionSamples = 0;

  const byPlatform: Record<string, { views: number; engagements: number; shares: number }> = {};

  for (const r of records) {
    if (r.views != null) totalViews += r.views;
    if (r.impressions != null) totalImpressions += r.impressions;
    if (r.clicks != null) totalClicks += r.clicks;
    if (r.conversions != null) totalConversions += r.conversions;
    if (r.spendCents != null) totalSpendCents += r.spendCents;
    if (r.revenueCents != null) totalRevenueCents += r.revenueCents;

    if (r.hookRetention3s != null && r.hookRetention3s > 0) {
      sumHookRetention += r.hookRetention3s;
      retentionSamples++;
    }
    if (r.completionRate != null && r.completionRate > 0) {
      sumCompletion += r.completionRate;
      completionSamples++;
    }

    if (!byPlatform[r.platform]) {
      byPlatform[r.platform] = { views: 0, engagements: 0, shares: 0 };
    }
    if (r.views != null) byPlatform[r.platform].views += r.views;
    if (r.engagements != null) byPlatform[r.platform].engagements += r.engagements;
    if (r.shares != null) byPlatform[r.platform].shares += r.shares;
  }

  const avgHookRetention3s = retentionSamples > 0 ? sumHookRetention / retentionSamples : 0;
  const avgCompletionRate = completionSamples > 0 ? sumCompletion / completionSamples : 0;
  const totalEngagements = Object.values(byPlatform).reduce((acc, p) => acc + p.engagements, 0);
  const avgEngagementRate = totalViews > 0 ? totalEngagements / totalViews : 0;

  const posteriorsByHookType = calculateTelemetryFeaturePosteriors(records, "hookType");
  const posteriorsByAngle = calculateTelemetryFeaturePosteriors(records, "angle");

  return {
    totalRecords: records.length,
    totalViews,
    totalImpressions,
    totalClicks,
    totalConversions,
    totalSpendCents,
    totalRevenueCents,
    avgHookRetention3s,
    avgCompletionRate,
    avgEngagementRate,
    byPlatform,
    posteriorsByHookType,
    posteriorsByAngle,
  };
}

// ---------------------------------------------------------------------------
// Closed-Loop Synchronization Flywheel
// ---------------------------------------------------------------------------

/**
 * Synchronizes unified telemetry into standard learning pattern stores
 * and dynamically updates JEV account profiles with learned priors.
 */
export async function syncTelemetryToLearning(
  sql: Sql,
  organizationId: string,
  brandId: string,
): Promise<TelemetrySyncResult> {
  const records = await getTelemetryRecords(sql, organizationId, brandId, { limit: 500 });
  if (records.length === 0) {
    return {
      syncedRecords: 0,
      patternsLearned: 0,
      topHooks: [],
      updatedAt: new Date().toISOString(),
    };
  }

  // 1. Bridge telemetry records that have creativeId into performance_observations
  for (const r of records) {
    if (!r.creativeId) continue;
    if (r.metadata?.synthetic === true || r.metadata?.simulated === true) {
      // Never bridge synthetic or simulated records into production learning
      continue;
    }

    // Check if observation exists for this creative
    const existing = await sql`
      select id from performance_observations
      where organization_id = ${organizationId}
        and brand_id = ${brandId}
        and creative_id = ${r.creativeId}
      limit 1
    `;

    if (!existing || existing.length === 0) {
      await sql`
        insert into performance_observations (
          id, organization_id, brand_id, creative_id, impressions, clicks, conversions,
          spend_cents, revenue_cents, observed_on, source
        ) values (
          ${randomUUID()}, ${organizationId}, ${brandId}, ${r.creativeId},
          ${Math.max(r.impressions ?? 0, r.views ?? 0)}, ${r.clicks ?? 0}, ${r.conversions ?? 0},
          ${r.spendCents ?? 0}, ${(r.revenueCents && r.revenueCents > 0) ? r.revenueCents : null},
          ${r.recordedAt.slice(0, 10)}, ${r.platform}
        )
      `;
    }

    // Bridge organic records directly into organic_observations for JEV retention & shares learning
    if (r.sourceType === "organic" || ((r.views ?? 0) > 0 && (r.spendCents ?? 0) === 0)) {
      try {
        const existingOrg = await sql`
          select id from organic_observations
          where organization_id = ${organizationId}
            and brand_id = ${brandId}
            and creative_id = ${r.creativeId}
          limit 1
        `;
        if (!existingOrg || existingOrg.length === 0) {
          const postId = r.externalPostId || `post_${r.creativeId}`;
          try {
            await sql`
              insert into organic_posts (
                id, organization_id, brand_id, creative_id, platform, caption, status
              ) values (
                ${postId}, ${organizationId}, ${brandId}, ${r.creativeId}, ${r.platform}, '', 'published'
              )
              on conflict (id) do nothing
            `;
          } catch {
            // Optional FK
          }

          const threeSecViews = (r.views != null && r.hookRetention3s != null) ? Math.round(r.views * r.hookRetention3s) : null;
          const compRate = r.completionRate != null ? r.completionRate : null;
          await sql`
            insert into organic_observations (
              id, organization_id, brand_id, organic_post_id, creative_id, platform,
              views, three_second_views, completion_rate, shares, likes, comments, saves,
              observed_on, created_at
            ) values (
              ${randomUUID()}, ${organizationId}, ${brandId}, ${postId}, ${r.creativeId}, ${r.platform},
              ${r.views}, ${threeSecViews}, ${compRate}, ${r.shares}, ${r.engagements},
              0, ${r.saves}, current_date, now()
            )
          `;
        }
      } catch {
        // Continue gracefully if organic_observations unavailable
      }
    }
  }

  // 2. Recompute brand-scoped Bayesian learned patterns
  let patternsCount = 0;
  try {
    patternsCount = await applyLearnedPatterns(sql, organizationId, brandId);
  } catch {
    // If creative records don't match or table is empty, continue gracefully
    patternsCount = 0;
  }

  // 3. Compute top hooks from unified telemetry Bayesian posteriors
  const hookPosteriors = calculateTelemetryFeaturePosteriors(records, "hookType");
  const topHooks = hookPosteriors
    .filter((h) => h.posterior.mean > h.baselineRate && h.sampleCount >= 2)
    .map((h) => h.featureValue)
    .slice(0, 5);

  // 4. Update JEV account profiles for this brand
  const topHooksJson = JSON.stringify(topHooks.length > 0 ? topHooks : ["contrarian", "question", "statistic"]);
  const avgEng = records.length > 0
    ? records.reduce((acc, r) => acc + (r.views != null && r.views > 0 && r.engagements != null ? r.engagements / r.views : 0), 0) / records.length
    : 0.05;

  try {
    const existingProfiles = await sql`
      select id from jev_account_profiles
      where organization_id = ${organizationId} and brand_id = ${brandId}
    `;

    if (existingProfiles && existingProfiles.length > 0) {
      await sql`
        update jev_account_profiles
        set top_hooks = ${topHooksJson},
            avg_engagement_rate = ${avgEng},
            updated_at = now()
        where organization_id = ${organizationId} and brand_id = ${brandId}
      `;
    } else {
      await sql`
        insert into jev_account_profiles (
          id, organization_id, brand_id, platform, account_handle, post_count,
          avg_engagement_rate, top_hooks, created_at, updated_at
        ) values (
          ${randomUUID()}, ${organizationId}, ${brandId}, 'cross-channel', '@brand',
          ${records.length}, ${avgEng}, ${topHooksJson}, now(), now()
        )
      `;
    }
  } catch {
    // Profile table update optional if not yet seeded
  }

  return {
    syncedRecords: records.length,
    patternsLearned: patternsCount,
    topHooks,
    updatedAt: new Date().toISOString(),
  };
}
