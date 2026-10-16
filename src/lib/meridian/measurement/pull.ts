/**
 * The measurement pull for one Factory run (NORTH_STAR section 8, item 9). The scheduler enqueues `measurement.pull` for a run that
 * has receipts to measure, and this reads them:
 *
 * - organic: each published post of the run is read through its channel's `fetchMetrics`, with the workspace's own stored token for that
 *   platform. Without a connected account the post is not read and the reason is kept. A channel with no read for its platform
 *   reports that as not implemented. A test passes the reading a platform returned, shaped as the channel returns it.
 * - paid: each paused ad of the run is read through the workspace's stored token and the insights reader. Without a stored token the
 *   ad is not measured. A test passes the insights it reported. The test publisher has no insights source.
 *
 * Every row goes through `recordLinkedMetric`, so it is linked to its creative and to a receipt of its surface, or it is refused. A
 * metric the source did not report is stored as null, never as zero. A repeated pull of the same observation stores nothing twice.
 */
import type { Sql } from "../learning/store.ts";
import { resolveOrganicConnection, isOrganicPlatform } from "../distribution/connection.ts";
import { listDistributionChannels } from "../distribution/registry.ts";
import type { DistributionChannel, OrganicConnection, OrganicMetricsReading, OrganicTelemetryMetrics } from "../distribution/types.ts";
import { loadProviderInsights } from "../performance/fetch.ts";
import type { PerformanceEvent } from "../performance/normalize.ts";
import { loadTenantProviderToken } from "../performance/ownership.ts";
import { liveTransport, type Transport } from "../providers/http.ts";
import { recordLinkedMetric, type LinkedMetrics } from "./creative-linkage.ts";

export type MeasurementScope = { organizationId: string; brandId: string; runId: string };

export type OrganicTarget = { creativeId: string; platform: string; externalId: string };

export type PaidTarget = { creativeId: string; provider: string; externalId: string };

export type PaidInsightsResult = { events: PerformanceEvent[] } | { notReported: string };

/** Where the metrics come from. A test passes fixtures; production passes nothing and uses the live readers. */
export type MeasurementSources = {
  /** A fixture reading of an organic post, shaped as the channel's `fetchMetrics` returns it. */
  organicMetrics?: (target: OrganicTarget) => Promise<OrganicMetricsReading>;
  paidInsights?: (target: PaidTarget) => Promise<PaidInsightsResult>;
  now?: Date;
};

export type MeasurementPullOutcome = {
  organicRows: number;
  paidRows: number;
  duplicates: number;
  /** Targets the pull read and got no metric for. Each one has a reason in `reasons`. Nothing was stored for them. */
  notReported: number;
  reasons: string[];
  summary: string;
};

/**
 * The workspace's own connected account for an organic platform, read from its stored token. A pull never uses an environment token,
 * so a platform with no connected account gets a not-connected connection, and its channel sends no request.
 */
async function organicConnectionOf(sql: Sql, scope: MeasurementScope, platform: string): Promise<OrganicConnection | undefined> {
  if (!isOrganicPlatform(platform)) return undefined;
  return resolveOrganicConnection(sql, { organizationId: scope.organizationId, brandId: scope.brandId, platform, purpose: "read" });
}

/** The published organic posts and paused paid ads of one run, the receipts a pull reads. */
async function targetsOf(sql: Sql, scope: MeasurementScope) {
  const organic = await sql<{ creative_id: string; platform: string; external_id: string }>`
    select p.creative_id, p.platform, p.external_id from organic_posts p
    where p.organization_id = ${scope.organizationId} and p.brand_id = ${scope.brandId}
      and p.surface = 'organic' and p.status = 'published' and p.external_id is not null and p.external_id <> ''
      and p.creative_id in (
        select creative_id from factory_creatives
        where run_id = ${scope.runId} and organization_id = ${scope.organizationId} and brand_id = ${scope.brandId}
      )
    order by p.created_at asc, p.id asc
  `;
  const paid = await sql<{ creative_id: string; provider: string; external_id: string }>`
    select p.idempotency_key as creative_id, p.provider, p.external_id from provider_objects p
    where p.organization_id = ${scope.organizationId} and p.brand_id = ${scope.brandId}
      and p.object_type = 'ad' and p.surface = 'paid' and p.status = 'paused' and p.external_id <> ''
      and p.idempotency_key in (
        select creative_id from factory_creatives
        where run_id = ${scope.runId} and organization_id = ${scope.organizationId} and brand_id = ${scope.brandId}
      )
    order by p.created_at asc, p.id asc
  `;
  return {
    organic: organic.map((row) => ({ creativeId: row.creative_id, platform: row.platform, externalId: row.external_id })),
    paid: paid.map((row) => ({ creativeId: row.creative_id, provider: row.provider, externalId: row.external_id })),
  };
}

/** The organic channel for a platform, from the registry. A platform with no channel has nothing to read. */
function organicChannelFor(platform: string): DistributionChannel | undefined {
  return listDistributionChannels().find((channel) => channel.platform === platform);
}

/** The default paid reader: the workspace's own stored token. A pull without the currency and timezone of the ad account stores nothing. */
async function defaultPaidInsights(sql: Sql, scope: MeasurementScope, target: PaidTarget): Promise<PaidInsightsResult> {
  if (target.provider === "test") return { notReported: "The test publisher has no insights source. Nothing was measured." };
  if (target.provider !== "meta" && target.provider !== "tiktok" && target.provider !== "google") {
    return { notReported: `${target.provider} has no insights reader. Nothing was measured.` };
  }
  const credential = await loadTenantProviderToken(sql, scope.organizationId, target.provider, process.env.TOKEN_ENCRYPTION_KEY ?? "");
  if (credential.status === "NOT_CONNECTED") return { notReported: credential.error };
  return {
    notReported: "The paid pull needs the ad account's currency and timezone, which are not stored for this receipt. Nothing was stored.",
  };
}

/**
 * The paid reader for a stored token and an explicit transport: the same insights reader the performance job uses. Production uses
 * the live transport; a test passes a fixture transport. The currency and timezone are the ad account's, as the caller states them.
 */
export function paidInsightsWithTransport(options: {
  accessToken: string;
  transport?: Transport;
  startDate: string;
  endDate: string;
  currency: string;
  timezone: string;
}): (target: PaidTarget) => Promise<PaidInsightsResult> {
  return async (target) => {
    const loaded = await loadProviderInsights(
      {
        provider: target.provider,
        externalAdId: target.externalId,
        creativeId: target.creativeId,
        currency: options.currency,
        timezone: options.timezone,
        startDate: options.startDate,
        endDate: options.endDate,
        accessToken: options.accessToken,
      },
      options.transport ?? liveTransport(),
    );
    return "error" in loaded ? { notReported: loaded.error } : { events: loaded.events };
  };
}

function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function organicMetricsRow(metrics: OrganicTelemetryMetrics): { metrics: LinkedMetrics; extra: Record<string, number | null> } {
  return {
    metrics: {
      views: metrics.views,
      reach: metrics.reach,
      impressions: null,
      clicks: null,
      engagements: null,
      shares: metrics.shares,
      saves: metrics.saves,
      conversions: null,
      spendCents: null,
      revenueCents: null,
      // The channels report an average watch time, not a total, so it is not summed into watch_time_seconds.
      watchTimeSeconds: null,
      hookRetention3s: null,
      completionRate: metrics.completionRate,
    },
    // Values with no column of their own. A metric the platform did not report is null, not zero.
    extra: {
      averageWatchTimeSeconds: metrics.averageWatchTimeSeconds,
      threeSecondViews: metrics.threeSecondViews,
      likes: metrics.likes,
      comments: metrics.comments,
    },
  };
}

function paidMetricsRow(event: PerformanceEvent): LinkedMetrics {
  return {
    views: null,
    reach: event.reach,
    impressions: event.impressions,
    clicks: event.clicks,
    engagements: null,
    shares: null,
    saves: null,
    conversions: event.conversions,
    spendCents: event.spendCents,
    revenueCents: event.revenueCents,
    watchTimeSeconds: null,
    hookRetention3s: null,
    completionRate: null,
  };
}

/** Reads and stores the metrics of one run's receipts. Each target is measured or reported as not reported; none is invented. */
export async function pullRunMeasurements(
  sql: Sql,
  scope: MeasurementScope,
  sources: MeasurementSources = {},
): Promise<MeasurementPullOutcome> {
  const now = sources.now ?? new Date();
  const targets = await targetsOf(sql, scope);
  const outcome: MeasurementPullOutcome = { organicRows: 0, paidRows: 0, duplicates: 0, notReported: 0, reasons: [], summary: "" };

  for (const target of targets.organic) {
    const channel = organicChannelFor(target.platform);
    if (!channel) {
      outcome.notReported += 1;
      outcome.reasons.push(`No organic channel reads ${target.platform} metrics. Nothing was stored.`);
      continue;
    }
    let reading: OrganicMetricsReading;
    try {
      reading = sources.organicMetrics
        ? await sources.organicMetrics(target)
        : await channel.fetchMetrics(target.externalId, await organicConnectionOf(sql, scope, target.platform));
    } catch {
      reading = { status: "failed", reason: `${channel.displayName} did not return metrics for this post. Nothing was stored.` };
    }
    // Only an observed reading is stored. Every other state is counted and its reason is kept, and no number is written for it.
    if (reading.status !== "observed") {
      outcome.notReported += 1;
      outcome.reasons.push(reading.reason);
      continue;
    }
    const row = organicMetricsRow(reading.metrics);
    const stored = await recordLinkedMetric(sql, {
      organizationId: scope.organizationId,
      brandId: scope.brandId,
      creativeId: target.creativeId,
      surface: "organic",
      externalId: target.externalId,
      observationKey: `organic:${target.externalId}:${dayOf(new Date(reading.observedAt))}`,
      recordedAt: reading.observedAt,
      metrics: row.metrics,
      extra: row.extra,
    });
    if (stored.status === "recorded") outcome.organicRows += 1;
    else outcome.duplicates += 1;
  }

  for (const target of targets.paid) {
    const result = sources.paidInsights ? await sources.paidInsights(target) : await defaultPaidInsights(sql, scope, target);
    if ("notReported" in result) {
      outcome.notReported += 1;
      outcome.reasons.push(result.notReported);
      continue;
    }
    for (const event of result.events) {
      const stored = await recordLinkedMetric(sql, {
        organizationId: scope.organizationId,
        brandId: scope.brandId,
        creativeId: target.creativeId,
        surface: "paid",
        externalId: target.externalId,
        observationKey: `paid:${event.externalId}`,
        recordedAt: event.observedOn ? `${event.observedOn}T00:00:00.000Z` : now.toISOString(),
        metrics: paidMetricsRow(event),
      });
      if (stored.status === "recorded") outcome.paidRows += 1;
      else outcome.duplicates += 1;
    }
  }

  outcome.summary = `measured:organic=${outcome.organicRows};paid=${outcome.paidRows};duplicates=${outcome.duplicates};not_reported=${outcome.notReported}`;
  return outcome;
}
