/**
 * The library listing: the brand's own creatives, newest first, each with the id of its stored asset. Plain SQL with no
 * server-function imports, so the listing can be tested directly on PGlite and PostgreSQL.
 */
import type { Sql } from "../learning/store.ts";

export const LIBRARY_LIST_LIMIT = 50;

export type LibraryCreativeRow = {
  id: string;
  title: string;
  origin: string;
  angle: string;
  hook: string;
  status: string;
  assetUrl: string;
  briefId: string;
  opportunityId: string;
  createdAt: string;
  /** The id /api/assets/<id> serves for this creative's first stored asset. Null when no stored asset exists. */
  assetId: string | null;
  /** 'image' or 'video' for that asset. Empty when there is no stored asset. */
  assetKind: string;
  /** The asset's own media status, such as completed. Empty when there is no stored asset. */
  assetMediaStatus: string;
};

function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/**
 * The first stored asset of each creative is joined on the asset's own status, so an asset that is not stored never
 * yields an id. The creative list is scoped to the caller's organization and brand.
 */
export async function loadLibraryCreatives(sql: Sql, organizationId: string, brandId: string): Promise<LibraryCreativeRow[]> {
  const rows = await sql<Record<string, unknown>>`
    select c.id, c.title, c.origin, c.angle, c.hook, c.status, c.asset_url, c.brief_id, c.opportunity_id, c.created_at,
           a.id as asset_id, a.kind as asset_kind, a.media_status as asset_media_status
    from creative_records c
    left join lateral (
      select s.id, s.kind, s.media_status
      from assets s
      where s.creative_id = c.id and s.organization_id = c.organization_id and s.brand_id = c.brand_id
        and s.status = 'stored' and s.kind in ('image', 'video')
      order by s.variant_index asc, s.created_at asc
      limit 1
    ) a on true
    where c.brand_id = ${brandId} and c.organization_id = ${organizationId} and c.origin <> 'competitor'
    order by c.created_at desc
    limit ${LIBRARY_LIST_LIMIT}
  `;
  return rows.map((row) => ({
    id: text(row.id),
    title: text(row.title),
    origin: text(row.origin),
    angle: text(row.angle),
    hook: text(row.hook),
    status: text(row.status),
    assetUrl: text(row.asset_url),
    briefId: text(row.brief_id),
    opportunityId: text(row.opportunity_id),
    createdAt: text(row.created_at),
    assetId: row.asset_id == null || text(row.asset_id) === "" ? null : text(row.asset_id),
    assetKind: text(row.asset_kind),
    assetMediaStatus: text(row.asset_media_status),
  }));
}
