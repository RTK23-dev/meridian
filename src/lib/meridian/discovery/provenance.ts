import type { Sql } from "../learning/store.ts";

export interface SourceObservation {
  runId: string;
  /** The stored item this observation is of. A repeat observation names the item it matched, not a second item. */
  itemId: string;
  discoveredAt: string;
  sourceLocation: string;
  cardType: string;
  /** False for the observation that stored the item. True for a later run that matched it and stored nothing new. */
  seenBefore: boolean;
}

export interface SourceProvenance {
  sourceKey: string;
  observations: SourceObservation[];
  runIds: string[];
  firstObservedAt: string | null;
  lastObservedAt: string | null;
}

/**
 * Every run that observed a source, in observation order: the run that stored the item, and each later run that matched it.
 * Read from the sightings, so a repeat run is listed without a second stored item. Scoped to one organization and brand,
 * and matched on the exact source key, so another tenant's observations never appear.
 */
export async function sourceProvenance(
  sql: Sql,
  scope: { organizationId: string; brandId: string; sourceKey: string },
): Promise<SourceProvenance> {
  const rows = await sql<{
    record_id: string; run_id: string; observed_at: string; seen_before: boolean; source_location: string | null; card_type: string;
  }>`
    select s.record_id, s.run_id, s.observed_at, s.seen_before, i.source_location, i.card_type
    from discovered_sightings s
    join discovered_items i on i.id = s.record_id
    where s.organization_id = ${scope.organizationId} and s.brand_id = ${scope.brandId} and s.source_key = ${scope.sourceKey}
    order by s.observed_at asc, s.id asc
  `;
  const observations: SourceObservation[] = rows.map((row) => ({
    runId: String(row.run_id),
    itemId: String(row.record_id),
    discoveredAt: String(row.observed_at),
    sourceLocation: String(row.source_location ?? ""),
    cardType: String(row.card_type),
    seenBefore: row.seen_before === true,
  }));
  return {
    sourceKey: scope.sourceKey,
    observations,
    runIds: [...new Set(observations.map((observation) => observation.runId))].sort(),
    firstObservedAt: observations[0]?.discoveredAt ?? null,
    lastObservedAt: observations[observations.length - 1]?.discoveredAt ?? null,
  };
}
