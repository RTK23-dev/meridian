/**
 * Stored counts for one brand, the numbers the overview, the workspace home and the sidebar read. Every count is scoped to
 * the caller's organization and to the brand, and each is a real count (zero when nothing is stored, never a guess).
 * Plain SQL with no server-function imports, so the counts can be tested on PGlite and PostgreSQL.
 */
import type { Sql } from "./learning/store.ts";

export type MachineCounts = {
  competitors: number;
  documents: number;
  observations: number;
  creatives: number;
  openOpportunities: number;
  reviews: number;
  patterns: number;
  performanceRows: number;
  /** JEV decision records for the brand. */
  decisions: number;
  /** Briefs for the brand, of any status. */
  briefs: number;
  /** Reviews a person has approved or rejected. Open reviews are waiting, not decided. */
  decidedReviews: number;
};

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

export async function loadMachineCounts(sql: Sql, organizationId: string, brandId: string): Promise<MachineCounts> {
  const rows = await sql<Record<string, unknown>>`
    select
      (select count(*) from competitors where brand_id = ${brandId} and organization_id = ${organizationId} and status = 'confirmed') as competitors,
      (select count(*) from source_documents where brand_id = ${brandId} and organization_id = ${organizationId} and status = 'stored') as documents,
      (select count(*) from creative_records where brand_id = ${brandId} and organization_id = ${organizationId} and origin = 'competitor') as observations,
      (select count(*) from creative_records where brand_id = ${brandId} and organization_id = ${organizationId} and origin <> 'competitor') as creatives,
      (select count(*) from opportunities where brand_id = ${brandId} and organization_id = ${organizationId} and status = 'open') as open_opportunities,
      (select count(*) from reviews where brand_id = ${brandId} and organization_id = ${organizationId} and status = 'open') as reviews,
      (select count(*) from learned_patterns where brand_id = ${brandId} and organization_id = ${organizationId}) as patterns,
      (select count(*) from performance_observations where brand_id = ${brandId} and organization_id = ${organizationId}) as performance_rows,
      (select count(*) from jev_decisions where brand_id = ${brandId} and organization_id = ${organizationId}) as decisions,
      (select count(*) from briefs where brand_id = ${brandId} and organization_id = ${organizationId}) as briefs,
      (select count(*) from reviews where brand_id = ${brandId} and organization_id = ${organizationId} and status in ('approved', 'rejected')) as decided_reviews
  `;
  const row = rows[0] ?? {};
  return {
    competitors: count(row.competitors),
    documents: count(row.documents),
    observations: count(row.observations),
    creatives: count(row.creatives),
    openOpportunities: count(row.open_opportunities),
    reviews: count(row.reviews),
    patterns: count(row.patterns),
    performanceRows: count(row.performance_rows),
    decisions: count(row.decisions),
    briefs: count(row.briefs),
    decidedReviews: count(row.decided_reviews),
  };
}
