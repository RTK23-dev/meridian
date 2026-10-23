/**
 * The pages and posts a discovery run stored for one brand, newest first. Each one is evidence someone can read. Ranking does not
 * read a page on its own: a member stores it as a competitor observation, which puts it in the ranking. The title and excerpt are
 * page text, so they are capped here, returned as plain strings, and never executed or rendered as markup.
 */
import { requireBrand } from "../brand-membership.ts";
import type { Sql } from "../learning/store.ts";

export const DISCOVERED_ITEM_LIST_LIMIT = 20;
export const DISCOVERED_TITLE_LIMIT = 200;
export const DISCOVERED_EXCERPT_LIMIT = 280;

export type DiscoveredItemRow = {
  id: string;
  runId: string;
  url: string;
  source: string;
  title: string;
  excerpt: string;
  discoveredAt: string;
};

function timestampText(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value ?? "");
}

export async function listDiscoveredItemsFor(sql: Sql, userId: string, brandId: string): Promise<DiscoveredItemRow[]> {
  const { organizationId } = await requireBrand(sql, userId, brandId, "viewer");
  const rows = await sql<Record<string, unknown>>`
    select id, run_id, url, source, title, text_content, discovered_at
    from discovered_items
    where organization_id = ${organizationId} and brand_id = ${brandId}
    order by discovered_at desc, id desc
    limit ${DISCOVERED_ITEM_LIST_LIMIT}
  `;
  return rows.map((row) => ({
    id: String(row.id),
    runId: String(row.run_id),
    url: String(row.url),
    source: String(row.source),
    title: String(row.title ?? "").replace(/\s+/g, " ").trim().slice(0, DISCOVERED_TITLE_LIMIT),
    excerpt: String(row.text_content ?? "").replace(/\s+/g, " ").trim().slice(0, DISCOVERED_EXCERPT_LIMIT),
    discoveredAt: timestampText(row.discovered_at),
  }));
}
