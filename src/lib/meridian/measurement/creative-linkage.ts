/**
 * Creative-level measurement linkage (P5a).
 *
 * A stored creative connects to three things: the production job that made it (its lineage), the publish receipts a
 * provider returned for it, and the telemetry rows measured for it. Each link is read from a key that already exists in
 * the schema, so nothing here creates a link that the data does not record:
 *
 * - publish receipts are provider_objects rows keyed by the creative. The distribution and test paths key them by the bare
 *   creative id; the Meta and Hypit video path keys them by `brandId:creativeId:video`. Both forms are matched, and no other
 *   key is guessed at, so a receipt in an unknown format is not linked. Each receipt carries the provider and the external
 *   id that provider returned. A receipt from the test provider is flagged, so a test publish is never read as a live one.
 * - telemetry rows are unified_performance_telemetry rows whose creative_id is the creative id.
 *
 * A creative with no receipt is unpublished, and one with no telemetry is unmeasured. Neither is reported as published or
 * measured by default.
 */
import type { Sql } from "../learning/store.ts";
import { reconstructCreativeLineage, type CreativeLineage } from "../production/lineage.ts";

/** The idempotency keys the publish paths write a creative's receipt under. Only these forms are matched. */
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

  const receipts = await sql<{ provider: string; object_type: string; external_id: string; status: string }>`
    select provider, object_type, external_id, status from provider_objects
    where organization_id = ${ref.organizationId} and brand_id = ${ref.brandId}
      and idempotency_key = any(${receiptKeysFor(ref.brandId, ref.creativeId)})
    order by created_at asc, id asc
  `;
  const publishReceipts: PublishReceipt[] = receipts.map((row) => ({
    provider: row.provider,
    objectType: row.object_type,
    externalId: row.external_id,
    status: row.status,
    isTestProvider: row.provider === "test",
  }));

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
