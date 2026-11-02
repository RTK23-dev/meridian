/**
 * The runs that saw one stored page, for a member of the page's brand (Market, "Where it was seen"). The brand is the one the caller
 * names and must be viewable by the caller; the page must belong to that brand. A page of another brand, or one that does not exist,
 * is reported as no record, so a page id reveals nothing about other brands. Read-only: nothing is stored or changed here.
 */
import { requireBrand } from "../brand-membership.ts";
import type { Sql } from "../learning/store.ts";
import { sourceProvenance, type SourceProvenance } from "./provenance.ts";

export async function itemProvenanceFor(sql: Sql, userId: string, brandId: string, itemId: string): Promise<SourceProvenance | null> {
  const { organizationId } = await requireBrand(sql, userId, brandId, "viewer");
  const rows = await sql<{ source_key: string }>`
    select source_key from discovered_sightings
    where organization_id = ${organizationId} and brand_id = ${brandId} and record_id = ${itemId}
    order by observed_at asc, id asc
    limit 1
  `;
  const sourceKey = rows[0]?.source_key;
  if (!sourceKey) return null;
  return sourceProvenance(sql, { organizationId, brandId, sourceKey });
}
