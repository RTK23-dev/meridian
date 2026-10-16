/**
 * Creative-level measurement linkage (P5a, NORTH_STAR section 8, item 9).
 *
 * A stored creative connects to three things: the production job that made it (its lineage), the publish receipts a
 * provider returned for it, and the telemetry rows measured for it. Each link is read from a key that already exists in
 * the schema, so nothing here creates a link that the data does not record:
 *
 * - organic receipts are organic_posts rows keyed by the creative id, with surface `organic`.
 * - paid receipts are provider_objects rows with surface `paid`. The distribution and test paths key them by the bare creative id,
 *   and the Meta and Hypit video path keys them by `brandId:creativeId:video`. Both forms are matched, and no other key is
 *   guessed at. A receipt from the test provider is flagged, so a test publish is never read as a live one.
 * - metric rows are unified_performance_telemetry rows whose creative_id is the creative id and whose source_type is the surface.
 *
 * A metric row is written only through `recordLinkedMetric`. It needs a creative id, a surface, and a receipt of that surface
 * for that creative with the external id the row was measured on. A row that fails any of these is refused, so no row exists
 * without a creative and a surface. A metric the source did not report is stored as null, never as zero.
 *
 * A creative with no confirmed receipt is unpublished, and one with no telemetry is unmeasured. Neither is reported as published
 * or measured by default. A receipt with no external id (not connected, or failed) is not a publish receipt.
 */
import type { Sql } from "../learning/store.ts";
import { recordTelemetryObservation } from "../learning/telemetry-engine.ts";
import { reconstructCreativeLineage, type CreativeLineage } from "../production/lineage.ts";

export type MeasurementSurface = "organic" | "paid";

/** The receipt statuses a provider confirmed. A paid object is confirmed as paused, which is its state at the provider. */
const CONFIRMED_STATUSES = ["published", "scheduled", "paused", "stored", "active"] as const;

/** The idempotency keys the publish paths write a creative's paid receipt under. Only these forms are matched. */
export function receiptKeysFor(brandId: string, creativeId: string): string[] {
  return [creativeId, `${brandId}:${creativeId}:video`];
}

export interface PublishReceipt {
  provider: string;
  objectType: string;
  externalId: string;
  status: string;
  /** True when the receipt came from the test provider. A test receipt is never a live publish. */
  isTestProvider: boolean;
  surface: MeasurementSurface;
}

export interface TelemetryLinkSummary {
  rowCount: number;
  latestRecordedAt: string | null;
}

export interface CreativeMeasurement {
  creativeId: string;
  lineage: CreativeLineage;
  publishReceipts: PublishReceipt[];
  telemetry: TelemetryLinkSummary;
  linked: {
    productionJob: boolean;
    publish: boolean;
    telemetry: boolean;
  };
}

export interface CreativeMeasurementRef {
  organizationId: string;
  brandId: string;
  creativeId: string;
}

/** The measurement links of one creative in this tenant, or null when the creative is not in this tenant. */
export async function linkCreativeMeasurement(sql: Sql, ref: CreativeMeasurementRef): Promise<CreativeMeasurement | null> {
  const lineage = await reconstructCreativeLineage(sql, ref);
  if (!lineage) return null;

  const organic = await sql<{ platform: string; external_id: string; status: string }>`
    select platform, external_id, status from organic_posts
    where organization_id = ${ref.organizationId} and brand_id = ${ref.brandId} and creative_id = ${ref.creativeId}
      and surface = 'organic' and external_id is not null and external_id <> ''
    order by created_at asc, id asc
  `;
  const paid = await sql<{ provider: string; object_type: string; external_id: string; status: string }>`
    select provider, object_type, external_id, status from provider_objects
    where organization_id = ${ref.organizationId} and brand_id = ${ref.brandId}
      and idempotency_key = any(${receiptKeysFor(ref.brandId, ref.creativeId)}) and surface = 'paid' and external_id <> ''
    order by created_at asc, id asc
  `;
  const publishReceipts: PublishReceipt[] = [
    ...organic.map((row) => ({
      provider: row.platform,
      objectType: "post",
      externalId: row.external_id,
      status: row.status,
      isTestProvider: false,
      surface: "organic" as const,
    })),
    ...paid.map((row) => ({
      provider: row.provider,
      objectType: row.object_type,
      externalId: row.external_id,
      status: row.status,
      isTestProvider: row.provider === "test",
      surface: "paid" as const,
    })),
  ].filter((receipt) => (CONFIRMED_STATUSES as readonly string[]).includes(receipt.status));

  const telemetry = await sql<{ row_count: number; latest: string | null }>`
    select count(*)::int as row_count, max(recorded_at)::text as latest
    from unified_performance_telemetry
    where organization_id = ${ref.organizationId} and brand_id = ${ref.brandId} and creative_id = ${ref.creativeId}
  `;
  const summary = telemetry[0];

  return {
    creativeId: ref.creativeId,
    lineage,
    publishReceipts,
    telemetry: {
      rowCount: Number(summary?.row_count ?? 0),
      latestRecordedAt: summary?.latest ?? null,
    },
    linked: {
      productionJob: lineage.productionJobId !== null,
      publish: publishReceipts.length > 0,
      telemetry: Number(summary?.row_count ?? 0) > 0,
    },
  };
}

/** The metrics one observation of a post or an ad carries. Each is the value the source reported, or null when it did not report it. */
export type LinkedMetrics = {
  views: number | null;
  reach: number | null;
  impressions: number | null;
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
};

export type LinkedMetricInput = {
  organizationId: string;
  brandId: string;
  creativeId: string;
  surface: MeasurementSurface;
  /** The external id of the receipt the row was measured on: a post id for organic, an ad id for paid. */
  externalId: string;
  /** Names one observation, so a repeated pull of the same observation stores nothing twice. */
  observationKey: string;
  recordedAt: string;
  metrics: LinkedMetrics;
  /** Values a surface reports that have no column of their own, such as comments. A missing one is null. */
  extra?: Record<string, number | null>;
};

export type LinkedMetricResult = { status: "recorded" } | { status: "duplicate" };

/** A metric row that cannot be linked to a creative, a surface and a receipt. Nothing is stored when it is thrown. */
export class MetricLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetricLinkError";
  }
}

/**
 * Stores one metric row, linked to its creative through a receipt of the same surface. The row is refused when the creative id, the
 * surface or the receipt is missing, or when the receipt is another surface's: a paid metric is never written for an organic receipt,
 * and the reverse. Metrics the source did not report stay null.
 */
export async function recordLinkedMetric(sql: Sql, input: LinkedMetricInput): Promise<LinkedMetricResult> {
  if (!input.creativeId.trim()) throw new MetricLinkError("A metric row needs a creative id. Nothing was stored.");
  if (input.surface !== "organic" && input.surface !== "paid") {
    throw new MetricLinkError("A metric row needs a surface, organic or paid. Nothing was stored.");
  }
  if (!input.externalId.trim()) throw new MetricLinkError("A metric row needs the external id of its receipt. Nothing was stored.");
  if (!input.observationKey.trim()) throw new MetricLinkError("A metric row needs an observation key. Nothing was stored.");

  const receipt = await receiptOfSurface(sql, input);
  if (!receipt) {
    throw new MetricLinkError(`No ${input.surface} publish receipt for this creative has that external id. Nothing was stored.`);
  }

  // The observation's unique key makes the insert the check: a second writer of the same observation stores nothing, however the two race.
  const m = input.metrics;
  const outcome = await recordTelemetryObservation(sql, {
    organizationId: input.organizationId,
    brandId: input.brandId,
    platform: receipt.platform,
    sourceType: input.surface,
    creativeId: input.creativeId,
    externalPostId: input.externalId,
    views: m.views,
    reach: m.reach,
    impressions: m.impressions,
    clicks: m.clicks,
    engagements: m.engagements,
    shares: m.shares,
    saves: m.saves,
    conversions: m.conversions,
    spendCents: m.spendCents,
    revenueCents: m.revenueCents,
    watchTimeSeconds: m.watchTimeSeconds,
    hookRetention3s: m.hookRetention3s,
    completionRate: m.completionRate,
    recordedAt: input.recordedAt,
    // The identity keys are written last, so no extra value can replace the observation key or the surface the unique key names.
    metadata: { ...(input.extra ?? {}), observationKey: input.observationKey, surface: input.surface },
  });
  return { status: outcome };
}

/** The receipt of the given surface that this creative and external id name in this tenant, or null. */
async function receiptOfSurface(sql: Sql, input: LinkedMetricInput): Promise<{ platform: string } | null> {
  if (input.surface === "organic") {
    const rows = await sql<{ platform: string }>`
      select platform from organic_posts
      where organization_id = ${input.organizationId} and brand_id = ${input.brandId} and creative_id = ${input.creativeId}
        and surface = 'organic' and external_id = ${input.externalId} and status in ('published', 'scheduled')
      limit 1
    `;
    return rows[0] ? { platform: rows[0].platform } : null;
  }
  const rows = await sql<{ provider: string }>`
    select provider from provider_objects
    where organization_id = ${input.organizationId} and brand_id = ${input.brandId}
      and idempotency_key = any(${receiptKeysFor(input.brandId, input.creativeId)})
      and surface = 'paid' and object_type = 'ad' and external_id = ${input.externalId}
      and status in ('paused', 'stored', 'active')
    limit 1
  `;
  return rows[0] ? { platform: rows[0].provider } : null;
}

/** One stored metric row, read back. Every metric is the value stored, or null when the source did not report it. */
export type LinkedMetricRow = {
  creativeId: string;
  surface: MeasurementSurface;
  platform: string;
  externalId: string;
  recordedAt: string;
  metrics: LinkedMetrics;
  observationKey: string;
};

/** The metric rows of the given creatives in this tenant. A row with no creative or no surface is not returned. */
export async function listLinkedMetrics(
  sql: Sql,
  scope: { organizationId: string; brandId: string },
  creativeIds: readonly string[],
): Promise<LinkedMetricRow[]> {
  if (creativeIds.length === 0) return [];
  const rows = await sql<Record<string, unknown>>`
    select creative_id, source_type, platform, external_post_id, recorded_at, metadata,
      views, reach, impressions, clicks, engagements, shares, saves, conversions, spend_cents, revenue_cents,
      watch_time_seconds, hook_retention_3s, completion_rate
    from unified_performance_telemetry
    where organization_id = ${scope.organizationId} and brand_id = ${scope.brandId}
      and creative_id = any(${[...creativeIds]}) and source_type in ('organic', 'paid') and creative_id <> ''
    order by recorded_at desc, id asc
  `;
  return rows.map((row) => ({
    creativeId: String(row.creative_id),
    surface: row.source_type === "paid" ? "paid" : "organic",
    platform: String(row.platform ?? ""),
    externalId: String(row.external_post_id ?? ""),
    recordedAt: String(row.recorded_at),
    observationKey: observationKeyOf(row.metadata),
    metrics: {
      views: metricValue(row.views),
      reach: metricValue(row.reach),
      impressions: metricValue(row.impressions),
      clicks: metricValue(row.clicks),
      engagements: metricValue(row.engagements),
      shares: metricValue(row.shares),
      saves: metricValue(row.saves),
      conversions: metricValue(row.conversions),
      spendCents: metricValue(row.spend_cents),
      revenueCents: metricValue(row.revenue_cents),
      watchTimeSeconds: metricValue(row.watch_time_seconds),
      hookRetention3s: metricValue(row.hook_retention_3s),
      completionRate: metricValue(row.completion_rate),
    },
  }));
}

/** A stored metric as a number, or null when nothing was stored. A stored zero is a value and stays zero. */
function metricValue(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function observationKeyOf(metadata: unknown): string {
  const record = typeof metadata === "string" ? safeParse(metadata) : metadata;
  if (!record || typeof record !== "object") return "";
  const key = (record as { observationKey?: unknown }).observationKey;
  return typeof key === "string" ? key : "";
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
