import type { Sql } from "../learning/store.ts";

/**
 * The stored public page for this brand whose text is exactly this text, or null. Identical stored text is the same record,
 * so a second fetch of it is reported as seen before instead of being stored as a new document. Scoped to one organization
 * and brand, so another brand's copy of the same text never matches.
 */
export async function storedPageWithText(
  sql: Sql,
  scope: { organizationId: string; brandId: string },
  excerpt: string,
): Promise<string | null> {
  const rows = await sql<{ id: string }>`
    select id from source_documents
    where organization_id = ${scope.organizationId} and brand_id = ${scope.brandId} and status = 'stored' and excerpt = ${excerpt}
    limit 1
  `;
  return rows[0]?.id ?? null;
}
