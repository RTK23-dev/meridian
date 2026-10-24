// The ideas a brand has declined or explored, read from its own opportunity rows and decision records. Scoped to the workspace and the
// brand. An open idea is not read: it is what a refresh replaces.

import type { Sql } from "../learning/store.ts";
import type { PriorIdea } from "./triage-memory.ts";

export async function readPriorIdeas(sql: Sql, organizationId: string, brandId: string): Promise<PriorIdea[]> {
  const rows = await sql<{
    id: string;
    label: string;
    hypothesis_id: string;
    product_id: string | null;
    angle: string;
    format: string;
    status: string;
    reason: string | null;
    decided_at: unknown;
  }>`
    select o.id, o.label, o.hypothesis_id, o.product_id, o.angle, o.format, o.status,
      d.reason, d.created_at as decided_at
    from opportunities o
    left join lateral (
      select reason, created_at from opportunity_direction_decisions
      where opportunity_id = o.id and organization_id = o.organization_id and action = 'decline'
      order by created_at desc limit 1
    ) d on true
    where o.organization_id = ${organizationId} and o.brand_id = ${brandId}
      and (o.status in ('accepted', 'briefed') or o.status = 'dismissed')
  `;
  return rows.map((row) => {
    const explored = row.status === "accepted" || row.status === "briefed";
    return {
      opportunityId: row.id,
      label: row.label,
      hypothesisId: row.hypothesis_id,
      productId: row.product_id,
      angle: row.angle,
      format: row.format,
      outcome: explored ? "explored" : "declined",
      reason: explored ? null : row.reason,
      decidedAt: row.decided_at === null || row.decided_at === undefined ? null : row.decided_at instanceof Date ? row.decided_at.toISOString() : String(row.decided_at),
    };
  });
}
