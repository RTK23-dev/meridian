// Reads the organic metrics of one repurpose run's published variations: the organic posts of the library creatives made from its reviewed
// variations. It is the same read the Factory run pull makes (pull.ts), for the receipts of derived creatives, and it writes through the same
// linkage (recordLinkedMetric), so each observation is tied to its receipt, keyed by day, and stored once.
//
// Only an observed reading is stored. A reading that is not connected, not implemented, or failed keeps its reason and writes no number, so a
// missing metric is never a zero. Paid ads are not read here: a paused ad has no delivery to measure, and nothing is activated.

import type { Sql } from "../learning/store.ts";
import { resolveOrganicConnection } from "../distribution/connection.ts";
import { FacebookPagesChannel } from "../distribution/facebook.ts";
import type { OrganicMetricsReading, OrganicTelemetryMetrics } from "../distribution/types.ts";
import { recordLinkedMetric, type LinkedMetrics } from "./creative-linkage.ts";
import { sessionAccess } from "../content-factory/service.ts";

export type RepurposeRunScope = { organizationId: string; brandId: string; repurposeRunId: string };

export type RepurposeTarget = { creativeId: string; platform: string; externalId: string };

export type RepurposePullOutcome = {
  organicRows: number;
  duplicates: number;
  notReported: number;
  reasons: string[];
};

export type RepurposePullSources = {
  /** Replaces the channel read in tests. Production reads each post through its own channel and the workspace's own connection. */
  organicMetrics?: (target: RepurposeTarget) => Promise<OrganicMetricsReading>;
  now?: Date;
};

function metricsRow(metrics: OrganicTelemetryMetrics): { metrics: LinkedMetrics; extra: Record<string, number | null> } {
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

/** The published organic receipts of the library creatives made from this run's variations. */
export async function repurposeRunTargets(sql: Sql, scope: RepurposeRunScope): Promise<RepurposeTarget[]> {
  const rows = await sql<{ creative_id: string; platform: string; external_id: string }>`
    select p.creative_id, p.platform, p.external_id
    from organic_posts p
    join creative_records c on c.id = p.creative_id and c.organization_id = p.organization_id
    join content_factory_repurpose_variants v on v.id = c.repurpose_variant_id and v.organization_id = c.organization_id
    join content_factory_repurpose_runs r on r.id = v.run_id and r.organization_id = v.organization_id
    where p.organization_id = ${scope.organizationId} and p.brand_id = ${scope.brandId} and r.id = ${scope.repurposeRunId}
      and p.surface = 'organic' and p.status = 'published' and p.external_id is not null and p.external_id <> ''
    order by p.created_at asc, p.id asc
  `;
  return rows.map((row) => ({ creativeId: row.creative_id, platform: row.platform, externalId: row.external_id }));
}

/**
 * Reads and stores the organic metrics of one repurpose run's published variations. A second read on the same day stores nothing new: the
 * observation key is the same, so it is counted as a duplicate. Nothing is read for a workspace other than the one the scope names.
 */
export async function pullRepurposeMeasurements(sql: Sql, scope: RepurposeRunScope, sources: RepurposePullSources = {}): Promise<RepurposePullOutcome> {
  const outcome: RepurposePullOutcome = { organicRows: 0, duplicates: 0, notReported: 0, reasons: [] };
  const targets = await repurposeRunTargets(sql, scope);
  for (const target of targets) {
    // Derived variations publish to Facebook Pages in this build, so Facebook is the only platform read here.
    if (target.platform !== "facebook") {
      outcome.notReported += 1;
      outcome.reasons.push(`No organic reader for ${target.platform} repurposed variations in this build. Nothing was stored.`);
      continue;
    }
    const channel = new FacebookPagesChannel();
    let reading: OrganicMetricsReading;
    try {
      reading = sources.organicMetrics
        ? await sources.organicMetrics(target)
        : await channel.fetchMetrics(
            target.externalId,
            await resolveOrganicConnection(sql, {
              organizationId: scope.organizationId,
              brandId: scope.brandId,
              platform: "facebook",
              purpose: "read",
            }),
          );
    } catch {
      reading = { status: "failed", reason: `${channel.displayName} did not return metrics for this post. Nothing was stored.` };
    }
    if (reading.status !== "observed") {
      outcome.notReported += 1;
      outcome.reasons.push(reading.reason);
      continue;
    }
    const row = metricsRow(reading.metrics);
    const stored = await recordLinkedMetric(sql, {
      organizationId: scope.organizationId,
      brandId: scope.brandId,
      creativeId: target.creativeId,
      surface: "organic",
      externalId: target.externalId,
      observationKey: `organic:${target.externalId}:${new Date(reading.observedAt).toISOString().slice(0, 10)}`,
      recordedAt: reading.observedAt,
      metrics: row.metrics,
      extra: row.extra,
    });
    if (stored.status === "recorded") outcome.organicRows += 1;
    else outcome.duplicates += 1;
  }
  return outcome;
}

/**
 * The admin action behind "Read Facebook metrics": reads the published variations of one repurpose run in the session's own workspace. It
 * never runs on its own: approval, publishing and rendering do not read metrics.
 */
export async function measureRepurposeRun(
  sql: Sql,
  userId: string,
  input: { sessionId: string; runId: string },
  sources: RepurposePullSources = {},
): Promise<RepurposePullOutcome> {
  const session = await sessionAccess(sql, userId, input.sessionId);
  if (!session.brand_id) throw new Error("This session has no brand, so there is nothing to measure.");
  const run = await sql<{ id: string }>`
    select id from content_factory_repurpose_runs
    where id = ${input.runId} and organization_id = ${session.organization_id} and session_id = ${session.id}
    limit 1
  `;
  if (!run[0]) throw new Error("That repurpose run is not part of this session.");
  return pullRepurposeMeasurements(sql, { organizationId: session.organization_id, brandId: session.brand_id, repurposeRunId: input.runId }, sources);
}
