import { randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import type { PageCrawlResult } from "./crawler.ts";
import { sourceExternalId } from "./source-identity.ts";

/**
 * Structured evidence a page declares about itself. Every record is `OBSERVED`: it says the page
 * declares this data, not that the declaration is true. Interpreting a claim belongs to JEV.
 */
export const MAX_EVIDENCE_PAYLOAD_BYTES = 64 * 1024;

export type PageEvidenceKind = "json_ld" | "open_graph" | "meta";

export interface PageEvidenceRecord {
  kind: PageEvidenceKind;
  payload: Record<string, unknown>;
}

type PageDeclarations = Pick<PageCrawlResult, "title" | "description" | "canonicalUrl" | "openGraph" | "jsonLd">;

/** A payload above the size cap is recorded as a marker with its size, never as a partial copy. */
function capped(kind: PageEvidenceKind, payload: Record<string, unknown>): PageEvidenceRecord {
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (bytes <= MAX_EVIDENCE_PAYLOAD_BYTES) return { kind, payload };
  return { kind, payload: { truncated: true, bytes } };
}

/** The records a page declares, one per kind that is present. A page that declares nothing yields none. */
export function buildPageEvidence(page: PageDeclarations): PageEvidenceRecord[] {
  const records: PageEvidenceRecord[] = [];
  if (page.jsonLd.length > 0) records.push(capped("json_ld", { items: page.jsonLd }));
  if (Object.keys(page.openGraph).length > 0) records.push(capped("open_graph", { tags: page.openGraph }));
  if (page.title || page.description) {
    records.push(capped("meta", { title: page.title, description: page.description, canonicalUrl: page.canonicalUrl }));
  }
  return records;
}

/**
 * Stores one page's declared evidence for a run. Each insert has its own error capture, and a failure is
 * recorded under a `persist_` key, so the run reports partial. It never drops the discovered items.
 */
export async function persistPageEvidence(
  sql: Sql,
  context: { organizationId: string; brandId: string; runId: string },
  page: PageDeclarations & { finalUrl: string },
  perSourceErrors: Record<string, string>,
): Promise<number> {
  const pageUrl = page.canonicalUrl || page.finalUrl;
  const sourceKey = sourceExternalId({ brandId: context.brandId, itemId: "", canonicalUrl: pageUrl });
  let stored = 0;
  for (const record of buildPageEvidence(page)) {
    try {
      await sql`
        insert into discovered_page_evidence (
          id, organization_id, brand_id, run_id, source_key, page_url, kind, payload, state, observed_at
        ) values (
          ${`ev_${randomUUID()}`}, ${context.organizationId}, ${context.brandId}, ${context.runId}, ${sourceKey},
          ${pageUrl}, ${record.kind}, ${JSON.stringify(record.payload)}, 'OBSERVED', now()
        )
        on conflict (run_id, page_url, kind) do nothing
      `;
      stored += 1;
    } catch (error) {
      perSourceErrors[`persist_evidence_${record.kind}_${pageUrl}`] = error instanceof Error ? error.message : String(error);
    }
  }
  return stored;
}
