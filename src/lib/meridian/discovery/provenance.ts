import type { Sql } from "../learning/store.ts";

export interface SourceObservation {
  runId: string;
  itemId: string;
  discoveredAt: string;
  sourceLocation: string;
  cardType: string;
}

export interface SourceProvenance {
  sourceKey: string;
  observations: SourceObservation[];
  runIds: string[];
  firstObservedAt: string | null;
  lastObservedAt: string | null;
}

/**
 * Every discovered item that observed a source, in discovery order. Scoped to one organization and brand,
 * and matched on the exact source key, so another tenant's observations never appear.
 */
export async function sourceProvenance(
  sql: Sql,
  scope: { organizationId: string; brandId: string; sourceKey: string },
): Promise<SourceProvenance> {
  const rows = await sql<{ id: string; run_id: string; discovered_at: string; source_location: string | null; card_type: string }>`
    select id, run_id, discovered_at, source_location, card_type from discovered_items
    where organization_id = ${scope.organizationId} and brand_id = ${scope.brandId} and source_key = ${scope.sourceKey}
    order by discovered_at asc, id asc
  `;
  const observations = rows.map((row) => ({
    runId: String(row.run_id),
    itemId: String(row.id),
    discoveredAt: String(row.discovered_at),
    sourceLocation: String(row.source_location ?? ""),
    cardType: String(row.card_type),
  }));
  return {
    sourceKey: scope.sourceKey,
    observations,
    runIds: [...new Set(observations.map((observation) => observation.runId))].sort(),
    firstObservedAt: observations[0]?.discoveredAt ?? null,
    lastObservedAt: observations[observations.length - 1]?.discoveredAt ?? null,
  };
}
