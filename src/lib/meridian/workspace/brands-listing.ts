/**
 * The brands of one workspace, as the bootstrap returns them. Each brand carries the id of its logo when a logo is stored and
 * servable, and null otherwise. Plain SQL with no server-function imports, so the listing can be tested directly.
 */
import { brainCompleteness, type BrainValues } from "@/lib/meridian/brain";
import type { Sql } from "../learning/store.ts";
import { BRAIN_COLUMNS, asText, brainFromRow } from "../api-shared.ts";
import type { BrandSummary } from "./actions.ts";

/**
 * The brand's required-field state, as the listing carries it. `completeness` is the share of required fields with content,
 * from 0 to 1, shown on the home list and the brain screen. `requiredComplete` is the gate: true only when every required
 * field has content. The gate reads the boolean, not the ratio, so the ratio can change without changing what counts as done.
 */
export function requiredState(brain: BrainValues): { completeness: number; requiredComplete: boolean } {
  const score = brainCompleteness(brain);
  return {
    completeness: score.requiredTotal === 0 ? 0 : score.requiredFilled / score.requiredTotal,
    requiredComplete: score.requiredComplete,
  };
}

export function requiredRatio(brain: BrainValues): number {
  return requiredState(brain).completeness;
}

/**
 * The newest stored logo of the brand whose bytes are in asset_blobs. A logo row without bytes is not offered, because the
 * asset route could not serve it.
 */
export async function loadWorkspaceBrands(sql: Sql, organizationId: string): Promise<BrandSummary[]> {
  const brandsQuery = `
    select b.id, b.name, b.website, b.industry, b.sells, b.country_market, b.updated_at,
           ${BRAIN_COLUMNS},
           (select a.id from assets a
             where a.brand_id = b.id and a.organization_id = b.organization_id and a.label = 'logo' and a.status = 'stored'
               and exists (
                 select 1 from asset_blobs ab
                 where ab.storage_key = a.storage_key and ab.organization_id = a.organization_id and ab.brand_id = a.brand_id
                   and ab.lifecycle = 'stored'
               )
             order by a.created_at desc limit 1) as logo_asset_id
    from brands b
    left join brand_brains br on br.brand_id = b.id
    where b.organization_id = $1 and b.deleted_at is null
    order by b.updated_at desc
  `;
  const rows = await sql.query<Record<string, unknown>>(brandsQuery, [organizationId]);
  return rows.map((row) => {
    const { brain } = brainFromRow(row);
    const logo = asText(row.logo_asset_id);
    const required = requiredState(brain);
    return {
      id: asText(row.id),
      name: asText(row.name),
      website: asText(row.website),
      industry: asText(row.industry),
      sells: asText(row.sells),
      country: asText(row.country_market),
      completeness: required.completeness,
      requiredComplete: required.requiredComplete,
      updatedAt: asText(row.updated_at),
      logoAssetId: logo || null,
    };
  });
}
