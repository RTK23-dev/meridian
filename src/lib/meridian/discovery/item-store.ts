/**
 * Stores one discovered item for a run, once per brand.
 *
 * Every discovery path (public pages, repeated cards, and each multi-source adapter) stores items here, so the dedupe rule
 * and the provenance columns are the same everywhere. An item whose content hash already exists for the brand is not stored
 * again. Its outcome is `seen_before`, and the caller counts it.
 */

import { randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import { sourceExternalId } from "./source-identity.ts";
import type { RecordProvenance } from "./content-identity.ts";
import type { DiscoveredItem } from "./types.ts";

export type ItemOutcome = "stored" | "seen_before";

/**
 * Records that this run observed a record. A stored record and a sighting of it are both observations, so a source lists every
 * run that saw it, and `seen_before` says which of them did not store anything new.
 */
async function recordSighting(
  sql: Sql,
  provenance: RecordProvenance,
  input: { recordId: string; sourceKey: string; seenBefore: boolean },
): Promise<void> {
  await sql`
    insert into discovered_sightings (
      id, organization_id, brand_id, run_id, record_id, source_key, seen_before, observed_at
    ) values (
      ${`sight_${randomUUID()}`}, ${provenance.organizationId}, ${provenance.brandId}, ${provenance.runId},
      ${input.recordId}, ${input.sourceKey}, ${input.seenBefore}, now()
    )
  `;
}

export async function storeDiscoveredItem(
  sql: Sql,
  provenance: RecordProvenance,
  item: DiscoveredItem,
): Promise<ItemOutcome> {
  const sourceKey = sourceExternalId({ brandId: provenance.brandId, itemId: item.id, canonicalUrl: item.canonicalUrl || item.url });
  const seen = await sql<{ id: string }>`
    select id from discovered_items
    where organization_id = ${provenance.organizationId} and brand_id = ${provenance.brandId} and content_hash = ${item.contentHash}
    limit 1
  `;
  if (seen[0]) {
    await recordSighting(sql, provenance, { recordId: seen[0].id, sourceKey, seenBefore: true });
    return "seen_before";
  }

  await sql`
    insert into discovered_items (
      id, run_id, organization_id, brand_id, source, url, canonical_url,
      card_type, title, text_content, metrics, content_hash, source_location, discovered_at, source_key,
      adapter_id, source_status
    ) values (
      ${item.id}, ${provenance.runId}, ${provenance.organizationId}, ${provenance.brandId},
      ${item.source}, ${item.url}, ${item.canonicalUrl || null},
      ${item.cardType}, ${item.title || null}, ${item.text || null},
      ${JSON.stringify(item.metrics || {})}, ${item.contentHash},
      ${item.sourceLocation || null}, now(),
      ${sourceKey},
      ${provenance.adapterId}, ${provenance.sourceStatus}
    )
    on conflict (id) do nothing
  `;
  await recordSighting(sql, provenance, { recordId: item.id, sourceKey, seenBefore: false });
  return "stored";
}

/** The source row for a stored item. One row per brand and web URL, so the same page found twice is one source. */
export async function upsertItemSource(sql: Sql, provenance: RecordProvenance, item: DiscoveredItem): Promise<void> {
  const canonical = item.canonicalUrl || item.url;
  await sql`
    insert into sources (
      id, organization_id, brand_id, platform, adapter_id, external_id,
      canonical_url, name, status, metadata, created_at, updated_at
    ) values (
      ${`src_${item.id}`}, ${provenance.organizationId}, ${provenance.brandId}, ${provenance.adapterId}, ${provenance.adapterId},
      ${sourceExternalId({ brandId: provenance.brandId, itemId: item.id, canonicalUrl: canonical })}, ${canonical},
      ${(item.title || canonical || item.id).slice(0, 100)}, 'ready', ${JSON.stringify(item)}, now(), now()
    )
    on conflict (organization_id, platform, external_id) do update set
      canonical_url = excluded.canonical_url,
      metadata = excluded.metadata,
      updated_at = now()
  `;
}
