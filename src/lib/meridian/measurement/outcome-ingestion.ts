/**
 * Outcome ingestion through the existing performance normalizer, with recency decay (P5b).
 *
 * A provider's insight row is attributed to a creative only through a publish receipt in the same tenant: the receipt's
 * external id must equal the row's ad id, and its key must name exactly one creative. A row that matches no receipt, or
 * matches receipts for more than one creative, is counted and not stored. It is never attached to a guessed creative.
 *
 * A row with no observation date is not stored either, because its recency cannot be computed. Each stored row is mapped by
 * the existing Meta insight normalizer, and persisted by the telemetry engine, which computes its decay weight from the
 * observation date. Ingestion is idempotent: a row for the same ad and day is stored once.
 *
 * Only Meta insights are wired here. TikTok and Google mappers exist, but their attribution is not written yet, so they are
 * not ingested.
 */
import type { Sql } from "../learning/store.ts";
import { recordTelemetry } from "../learning/telemetry-engine.ts";
import { metaInsightEvent, type InsightRow } from "../performance/sync.ts";

export interface MetaInsightInput {
  externalId: string;
  row: InsightRow;
  currency: string;
  timezone: string;
}

export interface OutcomeIngestResult {
  ingested: number;
  /** Already stored for this ad and day. Re-ingesting does not add a row. */
  duplicate: number;
  /** No receipt in this tenant names this ad. */
  unattributed: number;
  /** Receipts name this ad for more than one creative. Nothing is guessed. */
  ambiguous: number;
  /** No observation date, so recency cannot be computed and the row is not stored. */
  undated: number;
}

export interface OutcomeIngestRef {
  organizationId: string;
  brandId: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The creative a receipt key names, or null for a key in a form that names no creative. */
function creativeOfKey(brandId: string, key: string): string | null {
  const video = `${brandId}:`;
  if (key.startsWith(video) && key.endsWith(":video")) {
    const creativeId = key.slice(video.length, key.length - ":video".length);
    return creativeId.length > 0 ? creativeId : null;
  }
  return key.includes(":") ? null : key;
}

export async function ingestMetaOutcomes(
  sql: Sql,
  ref: OutcomeIngestRef,
  rows: MetaInsightInput[],
): Promise<OutcomeIngestResult> {
  const result: OutcomeIngestResult = { ingested: 0, duplicate: 0, unattributed: 0, ambiguous: 0, undated: 0 };

  for (const item of rows) {
    const observedOn = typeof item.row.date_start === "string" ? item.row.date_start : "";
    if (!DATE.test(observedOn)) {
      result.undated++;
      continue;
    }

    const receipts = await sql<{ idempotency_key: string }>`
      select idempotency_key from provider_objects
      where organization_id = ${ref.organizationId} and brand_id = ${ref.brandId}
        and provider = 'meta' and external_id = ${item.externalId}
    `;
    const creatives = [...new Set(receipts.map((receipt) => creativeOfKey(ref.brandId, receipt.idempotency_key)).filter((id): id is string => id !== null))];
    if (creatives.length === 0) {
      result.unattributed++;
      continue;
    }
    if (creatives.length > 1) {
      result.ambiguous++;
      continue;
    }
    const creativeId = creatives[0]!;

    const exists = await sql<{ id: string }>`
      select id from creative_records
      where id = ${creativeId} and organization_id = ${ref.organizationId} and brand_id = ${ref.brandId}
      limit 1
    `;
    if (!exists[0]) {
      result.unattributed++;
      continue;
    }

    const event = metaInsightEvent({ row: item.row, creativeId, externalId: item.externalId, currency: item.currency, timezone: item.timezone });
    const id = `meta-outcome:${item.externalId}:${observedOn}`;
    const stored = await sql<{ id: string }>`
      select id from unified_performance_telemetry
      where id = ${id} and organization_id = ${ref.organizationId} and brand_id = ${ref.brandId}
      limit 1
    `;
    if (stored[0]) {
      result.duplicate++;
      continue;
    }

    await recordTelemetry(sql, {
      id,
      organizationId: ref.organizationId,
      brandId: ref.brandId,
      platform: "meta",
      sourceType: "paid",
      creativeId,
      externalPostId: item.externalId,
      impressions: event.impressions,
      clicks: event.clicks,
      conversions: event.conversions,
      spendCents: event.spendCents,
      revenueCents: event.revenueCents,
      recordedAt: `${observedOn}T00:00:00.000Z`,
      metadata: { source: "meta_insights", currency: item.currency },
    });
    result.ingested++;
  }

  return result;
}
