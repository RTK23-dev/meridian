import { randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import type { PageCrawlResult } from "./crawler.ts";
import { sourceExternalId } from "./source-identity.ts";
import { canonicalPageKey, contentHashOf, type RecordProvenance } from "./content-identity.ts";

/**
 * Structured evidence a page declares about itself. Every record is `OBSERVED`: it says the page
 * declares this data, not that the declaration is true. Interpreting a claim belongs to JEV.
 */
export const MAX_EVIDENCE_PAYLOAD_BYTES = 64 * 1024;

export type PageEvidenceKind = "json_ld" | "open_graph" | "meta";

export interface PageEvidenceRecord {
  kind: PageEvidenceKind;
  payload: Record<string, unknown>;
  /** Hash of the full declared payload, taken before any size cap, so two different oversized payloads never match. */
  digest: string;
}

type PageDeclarations = Pick<PageCrawlResult, "title" | "description" | "canonicalUrl" | "openGraph" | "jsonLd">;

/** A payload above the size cap is recorded as a marker with its size, never as a partial copy. */
function capped(kind: PageEvidenceKind, payload: Record<string, unknown>): PageEvidenceRecord {
  const digest = contentHashOf(payload);
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (bytes <= MAX_EVIDENCE_PAYLOAD_BYTES) return { kind, payload, digest };
  return { kind, payload: { truncated: true, bytes }, digest };
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
 * Stores one page's declared evidence for a run, with its provenance: canonical URL, adapter, run, fetch time, content hash
 * and the source status at fetch time.
 *
 * A record whose content hash already exists for the brand is not stored again. It is counted as `seenBefore`, so the run
 * says it was seen before. Each insert has its own error capture, and a failure is recorded under a `persist_` key, so the
 * run reports partial. It never drops the discovered items.
 */
export async function persistPageEvidence(
  sql: Sql,
  provenance: RecordProvenance,
  page: PageDeclarations & { finalUrl: string; fetchedAt?: string },
  perSourceErrors: Record<string, string>,
): Promise<{ stored: number; seenBefore: number }> {
  const pageUrl = canonicalPageKey(page.canonicalUrl || page.finalUrl);
  const sourceKey = sourceExternalId({ brandId: provenance.brandId, itemId: "", canonicalUrl: pageUrl });
  const fetchedAt = page.fetchedAt ?? new Date().toISOString();
  let stored = 0;
  let seenBefore = 0;
  for (const record of buildPageEvidence(page)) {
    const contentHash = contentHashOf([pageUrl, record.kind, record.digest]);
    try {
      const seen = await sql<{ id: string }>`
        select id from discovered_page_evidence
        where organization_id = ${provenance.organizationId} and brand_id = ${provenance.brandId} and content_hash = ${contentHash}
        limit 1
      `;
      if (seen[0]) {
        seenBefore += 1;
        continue;
      }
      const inserted = await sql<{ id: string }>`
        insert into discovered_page_evidence (
          id, organization_id, brand_id, run_id, source_key, page_url, kind, payload, state, observed_at,
          adapter_id, content_hash, source_status
        ) values (
          ${`ev_${randomUUID()}`}, ${provenance.organizationId}, ${provenance.brandId}, ${provenance.runId}, ${sourceKey},
          ${pageUrl}, ${record.kind}, ${JSON.stringify(record.payload)}, 'OBSERVED', ${fetchedAt},
          ${provenance.adapterId}, ${contentHash}, ${provenance.sourceStatus}
        )
        on conflict (run_id, page_url, kind) do nothing
        returning id
      `;
      if (inserted[0]) stored += 1;
    } catch (error) {
      perSourceErrors[`persist_evidence_${record.kind}_${pageUrl}`] = error instanceof Error ? error.message : String(error);
    }
  }
  return { stored, seenBefore };
}
