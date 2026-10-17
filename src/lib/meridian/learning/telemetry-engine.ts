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
 * The record one telemetry row stores: the synthetic guard, the clamped values and the recency-decay weight. Every writer below uses it, so a
 * row is the same whichever path stores it.
 */
function telemetryRecordOf(input: TelemetryRecordInput, halfLifeDays: number): TelemetryRecord {
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
 * Persists a single unified telemetry record, automatically computing its recency-decay weight.
 */
export async function recordTelemetry(
  sql: Sql,
  input: TelemetryRecordInput,
  halfLifeDays = 14,
): Promise<TelemetryRecord> {
  const record = telemetryRecordOf(input, halfLifeDays);
  await sql`
    insert into unified_performance_telemetry (
      id, organization_id, brand_id, publish_job_id, account_id, platform, source_type,
      creative_id, variant_id, external_post_id, hook_type, angle, format,
      views, impressions, reach, clicks, engagements, shares, saves, conversions,
      spend_cents, revenue_cents, watch_time_seconds, hook_retention_3s, completion_rate,
      decay_weight, recorded_at, metadata
    ) values (
      ${record.id}, ${record.organizationId}, ${record.brandId}, ${record.publishJobId},
      ${record.accountId}, ${record.platform}, ${record.sourceType},
      ${record.creativeId}, ${record.variantId}, ${record.externalPostId},
      ${record.hookType}, ${record.angle}, ${record.format},
      ${record.views}, ${record.impressions}, ${record.reach}, ${record.clicks}, ${record.engagements},
      ${record.shares}, ${record.saves}, ${record.conversions}, ${record.spendCents}, ${record.revenueCents},
      ${record.watchTimeSeconds}, ${record.hookRetention3s}, ${record.completionRate},
      ${record.decayWeight}, ${record.recordedAt}, ${JSON.stringify(record.metadata)}
    )
  `;
  return record;
}

/**
 * Persists the telemetry row of one observation, unless that observation is already stored. An observation is named by
 * `metadata.observationKey` within its creative and surface: that is the unique key of migration 0098. The insert names the key as its
 * conflict target, so two writers that race for one observation store one row. The first gets "recorded", the other "duplicate".
 */
export async function recordTelemetryObservation(
  sql: Sql,
  input: TelemetryRecordInput,
  halfLifeDays = 14,
): Promise<"recorded" | "duplicate"> {
  const observationKey = input.metadata?.observationKey;
  if (typeof observationKey !== "string" || !observationKey.trim()) {
    throw new Error("A telemetry observation needs an observation key in its metadata. Nothing was stored.");
  }
  const record = telemetryRecordOf(input, halfLifeDays);
  const stored = await sql<{ id: string }>`
    insert into unified_performance_telemetry (
      id, organization_id, brand_id, publish_job_id, account_id, platform, source_type,
      creative_id, variant_id, external_post_id, hook_type, angle, format,
      views, impressions, reach, clicks, engagements, shares, saves, conversions,
      spend_cents, revenue_cents, watch_time_seconds, hook_retention_3s, completion_rate,
      decay_weight, recorded_at, metadata
    ) values (
      ${record.id}, ${record.organizationId}, ${record.brandId}, ${record.publishJobId},
      ${record.accountId}, ${record.platform}, ${record.sourceType},
      ${record.creativeId}, ${record.variantId}, ${record.externalPostId},
      ${record.hookType}, ${record.angle}, ${record.format},
      ${record.views}, ${record.impressions}, ${record.reach}, ${record.clicks}, ${record.engagements},
      ${record.shares}, ${record.saves}, ${record.conversions}, ${record.spendCents}, ${record.revenueCents},
      ${record.watchTimeSeconds}, ${record.hookRetention3s}, ${record.completionRate},
      ${record.decayWeight}, ${record.recordedAt}, ${JSON.stringify(record.metadata)}
    )
    on conflict (organization_id, brand_id, creative_id, source_type, (metadata->>'observationKey')) do nothing
    returning id
  `;
  return stored.length > 0 ? "recorded" : "duplicate";
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

/** The external id a paid observation carries: the unified telemetry row it was bridged from. One measurement is one key. */
export function paidObservationKey(telemetryRowId: string): string {
  return `telemetry:${telemetryRowId}`;
}

/** The key an organic observation carries in raw_metrics. One telemetry row is one key, so a later day is a new row. */
export function organicObservationKey(telemetryRowId: string): string {
  return `telemetry:${telemetryRowId}`;
}

/**
 * The calendar day of a measurement, as YYYY-MM-DD. A value that starts with its ISO date keeps that date; a Date is read in UTC; any
 * other text is parsed. Telemetry rows are written in UTC, so the day is the UTC day.
 */
function dayOf(value: unknown): string {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text.slice(0, 10) : parsed.toISOString().slice(0, 10);
}

/** Two nullable counts match when both are unknown, or both are the same number. An unknown count never matches a zero. */
function sameCount(stored: unknown, value: number | null | undefined): boolean {
  if (stored == null) return value == null;
  return value != null && Number(stored) === value;
}

/**
 * Writes the paid observation of one measured telemetry row. The observation is keyed by that row, so a later measurement of the same
 * creative is a new observation, and running the sync again adds nothing. The earlier code wrote one observation per creative with no
 * key. Such a row is adopted by this key when its day and values match, so that measurement is not counted a second time.
 */
async function bridgePaidObservation(sql: Sql, organizationId: string, brandId: string, record: TelemetryRecord): Promise<void> {
  const key = paidObservationKey(record.id);
  const keyed = await sql<{ id: string }>`
    select id from performance_observations
    where organization_id = ${organizationId} and brand_id = ${brandId} and external_id = ${key}
    limit 1
  `;
  if (keyed.length > 0) return;

  const day = dayOf(record.recordedAt);
  const earlier = await sql<{
    id: string;
    observed_on: unknown;
    impressions: unknown;
    clicks: unknown;
    conversions: unknown;
    spend_cents: unknown;
    reach: unknown;
  }>`
    select id, observed_on, impressions, clicks, conversions, spend_cents, reach from performance_observations
    where organization_id = ${organizationId} and brand_id = ${brandId} and creative_id = ${record.creativeId}
      and created_by = 'telemetry.sync' and external_id = ''
  `;
  const adopted = earlier.find((row) =>
    dayOf(row.observed_on) === day
    && sameCount(row.impressions, record.impressions)
    && sameCount(row.clicks, record.clicks)
    && sameCount(row.conversions, record.conversions)
    && sameCount(row.spend_cents, record.spendCents)
    && sameCount(row.reach, record.reach));
  if (adopted) {
    await sql`update performance_observations set external_id = ${key} where id = ${adopted.id} and external_id = ''`;
    return;
  }

  await sql`
    insert into performance_observations (
      id, organization_id, brand_id, creative_id, impressions, clicks, conversions,
      spend_cents, revenue_cents, reach, observed_on, source, created_by, external_id
    ) values (
      ${randomUUID()}, ${organizationId}, ${brandId}, ${record.creativeId},
      ${record.impressions ?? null}, ${record.clicks ?? null}, ${record.conversions ?? null},
      ${record.spendCents ?? null}, ${(record.revenueCents && record.revenueCents > 0) ? record.revenueCents : null}, ${record.reach ?? null},
      ${day}, ${record.platform}, 'telemetry.sync', ${key}
    )
  `;
}

/**
 * Writes the organic observation of one measured telemetry row. The observation is keyed by that row, so a later day of the same
 * post is a new observation, and running the sync again adds nothing. A row written before keys existed is adopted when its day
 * and values match, so that measurement is not counted a second time.
 */
async function bridgeOrganicObservation(
  sql: Sql,
  organizationId: string,
  brandId: string,
  record: TelemetryRecord,
  externalPostId: string,
): Promise<void> {
  const key = organicObservationKey(record.id);
  const posts = await sql<{ id: string }>`
    select id from organic_posts
    where organization_id = ${organizationId} and platform = ${record.platform} and external_id = ${externalPostId}
    limit 1
  `;
  let postId = posts[0]?.id;
  if (!postId) {
    postId = randomUUID();
    await sql`
      insert into organic_posts (
        id, organization_id, brand_id, creative_id, platform, external_id, caption, status
      ) values (
        ${postId}, ${organizationId}, ${brandId}, ${record.creativeId}, ${record.platform}, ${externalPostId}, '', 'published'
      )
    `;
  }

  const keyed = await sql<{ id: string }>`
    select id from organic_observations
    where organization_id = ${organizationId} and brand_id = ${brandId} and organic_post_id = ${postId}
      and raw_metrics->>'observationKey' = ${key}
    limit 1
  `;
  if (keyed.length > 0) return;

  const day = dayOf(record.recordedAt);
  const threeSecViews = record.views != null && record.hookRetention3s != null ? Math.round(record.views * record.hookRetention3s) : null;
  const earlier = await sql<{
    id: string;
    observed_on: unknown;
    views: unknown;
    shares: unknown;
    likes: unknown;
    saves: unknown;
  }>`
    select id, observed_on, views, shares, likes, saves from organic_observations
    where organization_id = ${organizationId} and brand_id = ${brandId} and organic_post_id = ${postId}
      and (raw_metrics->>'observationKey' is null or raw_metrics->>'observationKey' = '')
  `;
  const adopted = earlier.find((row) =>
    dayOf(row.observed_on) === day
    && sameCount(row.views, record.views)
    && sameCount(row.shares, record.shares)
    && sameCount(row.likes, record.engagements)
    && sameCount(row.saves, record.saves));
  if (adopted) {
    await sql`
      update organic_observations
      set raw_metrics = coalesce(raw_metrics, '{}'::jsonb) || ${JSON.stringify({ observationKey: key })}::jsonb
      where id = ${adopted.id}
        and (raw_metrics->>'observationKey' is null or raw_metrics->>'observationKey' = '')
    `;
    return;
  }

  await sql`
    insert into organic_observations (
      id, organization_id, brand_id, organic_post_id, creative_id, platform,
      views, reach, three_second_views, completion_rate, shares, likes, comments, saves,
      observed_on, raw_metrics, created_at
    ) values (
      ${randomUUID()}, ${organizationId}, ${brandId}, ${postId}, ${record.creativeId}, ${record.platform},
      ${record.views ?? null}, ${record.reach ?? null}, ${threeSecViews}, ${record.completionRate ?? null},
      ${record.shares ?? null}, ${record.engagements ?? null}, null, ${record.saves ?? null},
      ${day}, ${JSON.stringify({ observationKey: key })}::jsonb, now()
    )
  `;
}

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

  // 1. Bridge telemetry records that have creativeId into performance_observations and organic_observations. A metric the
  // source did not report is stored as null: never zero, and never copied from another metric.
  for (const r of records) {
    if (!r.creativeId) continue;
    if (r.metadata?.synthetic === true || r.metadata?.simulated === true) {
      // Never bridge synthetic or simulated records into production learning
      continue;
    }

    // A paid row needs at least one paid metric. Views are reach, so they never stand in for impressions. Only a paid row is a paid
    // observation: an organic row that carries an impression count is still an organic outcome, and must not train paid learning.
    const paidMeasured =
      r.sourceType === "paid" && (r.impressions != null || r.clicks != null || r.conversions != null || r.spendCents != null);
    // One paid observation per measured row, so a later measurement of the same creative is counted, and a repeated sync is not.
    if (paidMeasured) await bridgePaidObservation(sql, organizationId, brandId, r);

    // Organic records bridge into organic_posts and organic_observations, for JEV retention and shares learning. A post row
    // needs the platform's own post id, which is the receipt. Without one, nothing is written for the record.
    const externalPostId = (r.externalPostId ?? "").trim();
    const organicMeasured = r.views != null || r.engagements != null || r.shares != null || r.saves != null;
    if (r.sourceType === "organic" && externalPostId && organicMeasured) {
      try {
        await bridgeOrganicObservation(sql, organizationId, brandId, r, externalPostId);
      } catch {
        // Continue gracefully if the organic tables are unavailable
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
  // No synthetic priors: topHooks is fitted strictly from observed data (empty if no posterior yet)
  const topHooksJson = JSON.stringify(topHooks);
  const recordsWithViews = records.filter((r) => r.views != null && r.views > 0);
  const avgEng = recordsWithViews.length > 0
    ? recordsWithViews.reduce((acc, r) => acc + (r.engagements != null ? r.engagements / r.views! : 0), 0) / recordsWithViews.length
    : 0;

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
