/**
 * Meridian records a Content Factory session can point at: the brand brain, products, library creatives, theme pages and market
 * research ads. Read only, from existing data, with the existing readers where one exists (library/listing.ts, pages/store.ts,
 * research/ad-listing.ts). Every read is scoped to one workspace and one of its brands; the caller has checked both.
 *
 * A snapshot is a short line of plain text shown to the person and passed to the engine as data. Ad copy, transcripts and other
 * fetched text are untrusted: they are cut short, never rendered as HTML and never treated as instructions.
 */
import type { Sql } from "../learning/store.ts";
import { BRAIN_FIELDS } from "../brain.ts";
import { loadLibraryCreatives } from "../library/listing.ts";
import { getThemePage, listThemePages } from "../pages/store.ts";
import { pageRequestKits, type PageRequestKits } from "../pages/model.ts";
import { loadResearchAds } from "../research/ad-listing.ts";
import { snapshotText, type SourcePage, type SourceResult } from "./model.ts";

export const SOURCE_RESULT_LIMIT = 20;

type Scope = { organizationId: string; brandId: string };

const BRAIN_SNAPSHOT_KEYS = ["positioning", "valueProposition", "targetCustomers", "tone", "prohibitedClaims", "requiredDisclaimers"] as const;

function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

async function brainResults(sql: Sql, scope: Scope): Promise<SourceResult[]> {
  const columns = BRAIN_FIELDS.filter((field) => (BRAIN_SNAPSHOT_KEYS as readonly string[]).includes(field.key));
  const rows = await sql.query<Record<string, unknown>>(
    `select b.name, ${columns.map((field) => `br.${field.column}`).join(", ")}
     from brands b left join brand_brains br on br.brand_id = b.id
     where b.id = $1 and b.organization_id = $2 and b.deleted_at is null limit 1`,
    [scope.brandId, scope.organizationId],
  );
  const row = rows[0];
  if (!row) return [];
  const parts = columns.map((field) => (text(row[field.column]) ? `${field.label}: ${text(row[field.column])}` : ""));
  const snapshot = snapshotText(parts);
  return [{ page: "brain", brandId: scope.brandId, recordId: scope.brandId, title: `Brand brain of ${text(row.name)}`, snapshot: snapshot || "The brand brain has no answers yet." }];
}

async function productResults(sql: Sql, scope: Scope): Promise<SourceResult[]> {
  const rows = await sql<Record<string, unknown>>`
    select p.id, p.name, p.description, p.benefits, p.price
    from products p join brands b on b.id = p.brand_id
    where p.brand_id = ${scope.brandId} and b.organization_id = ${scope.organizationId} and p.deleted_at is null
    order by p.created_at desc limit 100
  `;
  return rows.map((row) => ({
    page: "product" as const,
    brandId: scope.brandId,
    recordId: text(row.id),
    title: text(row.name) || "Untitled product",
    snapshot: snapshotText([text(row.name), text(row.description), text(row.benefits) ? `Benefits: ${text(row.benefits)}` : "", text(row.price) ? `Price: ${text(row.price)}` : ""]),
  }));
}

async function libraryResults(sql: Sql, scope: Scope): Promise<SourceResult[]> {
  const rows = await loadLibraryCreatives(sql, scope.organizationId, scope.brandId);
  return rows.map((row) => ({
    page: "library" as const,
    brandId: scope.brandId,
    recordId: row.id,
    title: row.title || "Untitled creative",
    snapshot: snapshotText([row.title, row.hook ? `Hook: ${row.hook}` : "", row.angle ? `Angle: ${row.angle}` : "", `Status: ${row.status}`]),
  }));
}

function pageSnapshot(page: { name: string; niche: string | null; platform: string; styleKitId: string | null; personaKitId: string | null; voiceKitId: string | null }): string {
  return snapshotText([
    page.name,
    page.niche ? `Niche: ${page.niche}` : "",
    `Platform: ${page.platform}`,
    `Style kit: ${page.styleKitId ?? "not set"}`,
    `Persona kit: ${page.personaKitId ?? "not set"}`,
    `Voice kit: ${page.voiceKitId ?? "not set"}`,
  ]);
}

async function pageResults(sql: Sql, scope: Scope): Promise<SourceResult[]> {
  const pages = await listThemePages(sql, scope);
  return pages.map((page) => ({ page: "page" as const, brandId: scope.brandId, recordId: page.id, title: page.name, snapshot: pageSnapshot(page) }));
}

async function marketResults(sql: Sql, scope: Scope): Promise<SourceResult[]> {
  const ads = await loadResearchAds(sql, scope.organizationId, scope.brandId);
  return ads.map((ad) => ({
    page: "market" as const,
    brandId: scope.brandId,
    recordId: ad.id,
    title: ad.headline || ad.advertiser || "Research ad",
    snapshot: snapshotText([ad.advertiser ? `Advertiser: ${ad.advertiser}` : "", ad.headline, ad.copy, ad.mediaType ? `Media: ${ad.mediaType}` : ""]),
  }));
}

const READERS: Record<SourcePage, (sql: Sql, scope: Scope) => Promise<SourceResult[]>> = {
  brain: brainResults,
  product: productResults,
  library: libraryResults,
  page: pageResults,
  market: marketResults,
};

/** The records of one page of one brand whose title or snapshot contains the query (case does not matter), at most 20. */
export async function searchSourceRecords(sql: Sql, scope: Scope, page: SourcePage, query: string): Promise<SourceResult[]> {
  const needle = query.trim().toLowerCase();
  const results = await READERS[page](sql, scope);
  return results
    .filter((result) => !needle || result.title.toLowerCase().includes(needle) || result.snapshot.toLowerCase().includes(needle))
    .slice(0, SOURCE_RESULT_LIMIT);
}

/** One record, read again on the server by its id. Null when the brand has no such record: a client's snapshot is never trusted. */
export async function readSourceRecord(sql: Sql, scope: Scope, page: SourcePage, recordId: string): Promise<SourceResult | null> {
  if (page === "page") {
    const found = await getThemePage(sql, scope, recordId);
    return found ? { page, brandId: scope.brandId, recordId: found.id, title: found.name, snapshot: pageSnapshot(found) } : null;
  }
  const results = await READERS[page](sql, scope);
  return results.find((result) => result.recordId === recordId) ?? null;
}

/** The engine kits of a theme page, read at start time, or null when it is not a page of the brand. */
export async function themePageKits(sql: Sql, scope: Scope, pageId: string): Promise<PageRequestKits | null> {
  const page = await getThemePage(sql, scope, pageId);
  return page ? pageRequestKits(page) : null;
}
