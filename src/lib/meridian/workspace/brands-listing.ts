/**
 * The brands of one workspace, as the bootstrap returns them. Each brand carries the id of its logo when a logo is stored and
 * servable, and null otherwise. Plain SQL with no server-function imports, so the listing can be tested directly.
 */
import { brainCompleteness } from "@/lib/meridian/brain";
import type { Sql } from "../learning/store.ts";
import { BRAIN_COLUMNS, asText, brainFromRow } from "../api-shared.ts";
import type { BrandSummary } from "./actions.ts";

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
    return {
      id: asText(row.id),
      name: asText(row.name),
      website: asText(row.website),
      industry: asText(row.industry),
      sells: asText(row.sells),
      country: asText(row.country_market),
      completeness: brainCompleteness(brain).ratio,
      updatedAt: asText(row.updated_at),
      logoAssetId: logo || null,
    };
  });
}
