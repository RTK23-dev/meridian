/**
 * The attribution one published reel carries: a UTM-tagged link and a unique DM keyword. Both are derived from the organization
 * and the reel, so the same reel always gets the same values, and the unique rules in migration 0092 keep them unique.
 *
 * The publish step calls reelAttributionFor and puts linkUrl in the caption or the bio link. The engine request passes dmKeyword
 * to the CTA card's keyword prop. Neither file is edited here (engine-request.ts and publish.ts belong to other workstreams).
 */
import { createHash } from "node:crypto";
import type { Sql } from "../learning/store.ts";

/** 32 characters, with no I, O, 0 or 1, so a keyword read aloud or typed from a screen is not ambiguous. */
export const KEYWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const KEYWORD_LENGTH = 8;
/** Candidates tried in order when a keyword is already taken. Each one is derived, so the order is fixed. */
const KEYWORD_ATTEMPTS = 8;

export type ReelAttributionRecord = {
  creativeId: string;
  dmKeyword: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  utmContent: string;
  /** The brand's product page the link points at, or null when the brand has none. */
  destinationUrl: string | null;
  /** The product page with the UTM values, or null when there is no destination. Null is never replaced by a guess. */
  linkUrl: string | null;
  /** Why there is no link, in words, or null when there is one. */
  reason: string | null;
};

function digestOf(...parts: string[]): Buffer {
  return createHash("sha256").update(parts.join("\n"), "utf8").digest();
}

/** The DM keyword for one reel, from its candidate number. Deterministic, uppercase, KEYWORD_LENGTH characters. */
export function keywordFor(organizationId: string, creativeId: string, attempt: number): string {
  const bytes = digestOf(organizationId, creativeId, "keyword", String(attempt));
  let keyword = "";
  for (let index = 0; index < KEYWORD_LENGTH; index += 1) {
    keyword += KEYWORD_ALPHABET.charAt((bytes[index] ?? 0) % KEYWORD_ALPHABET.length);
  }
  return keyword;
}

/** The utm_content for one reel: "mr" and twelve hex characters. It is the join key an order's landing site carries. */
export function utmContentFor(organizationId: string, creativeId: string): string {
  return `mr${digestOf(organizationId, creativeId, "utm_content").toString("hex").slice(0, 12)}`;
}

/** The utm_campaign for a brand: lowercase letters, digits and underscores. */
export function utmCampaignFor(brandId: string): string {
  return `meridian_${brandId.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`.slice(0, 100);
}

/**
 * The destination with the UTM values set. The existing query string is kept. A destination that is not an http or https URL
 * gives null, so no link is made from it.
 */
export function reelLinkUrl(
  destination: string,
  params: { utmSource: string; utmMedium: string; utmCampaign: string; utmContent: string },
): string | null {
  let url: URL;
  try {
    url = new URL(destination.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  url.searchParams.set("utm_source", params.utmSource);
  url.searchParams.set("utm_medium", params.utmMedium);
  url.searchParams.set("utm_campaign", params.utmCampaign);
  url.searchParams.set("utm_content", params.utmContent);
  return url.toString();
}

type AttributionRow = {
  creative_id: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  dm_keyword: string;
  destination_url: string | null;
  link_url: string | null;
};

function recordOf(row: AttributionRow): ReelAttributionRecord {
  return {
    creativeId: row.creative_id,
    dmKeyword: row.dm_keyword,
    utmSource: row.utm_source,
    utmMedium: row.utm_medium,
    utmCampaign: row.utm_campaign,
    utmContent: row.utm_content,
    destinationUrl: row.destination_url,
    linkUrl: row.link_url,
    reason: row.link_url ? null : "No product URL is set for this brand, so the reel has a keyword but no link.",
  };
}

async function readAttribution(sql: Sql, organizationId: string, creativeId: string): Promise<ReelAttributionRecord | null> {
  const rows = await sql<AttributionRow>`
    select creative_id, utm_source, utm_medium, utm_campaign, utm_content, dm_keyword, destination_url, link_url
    from reel_attributions
    where organization_id = ${organizationId} and creative_id = ${creativeId}
    limit 1
  `;
  return rows[0] ? recordOf(rows[0]) : null;
}

/**
 * The attribution for one reel, created on first call and returned unchanged after that. Null when the reel is not in this
 * brand, so nothing is made for another tenant's reel. The keyword is reserved by a unique rule. A candidate taken by another
 * reel is skipped, and the next one is tried. If every candidate is taken, the call throws rather than reusing one.
 */
export async function reelAttributionFor(
  sql: Sql,
  input: { organizationId: string; brandId: string; creativeId: string },
): Promise<ReelAttributionRecord | null> {
  const creatives = await sql<{ id: string }>`
    select id from creative_records
    where id = ${input.creativeId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
    limit 1
  `;
  if (!creatives[0]) return null;
  const existing = await readAttribution(sql, input.organizationId, input.creativeId);
  if (existing) return existing;

  const products = await sql<{ url: string }>`
    select url from products
    where brand_id = ${input.brandId} and deleted_at is null and url <> ''
    order by created_at asc, id asc
    limit 1
  `;
  const destination = products[0]?.url?.trim() ?? "";
  const utmCampaign = utmCampaignFor(input.brandId);
  const utmContent = utmContentFor(input.organizationId, input.creativeId);
  const linkUrl = destination
    ? reelLinkUrl(destination, { utmSource: "meridian", utmMedium: "reel", utmCampaign, utmContent })
    : null;

  for (let attempt = 0; attempt < KEYWORD_ATTEMPTS; attempt += 1) {
    const dmKeyword = keywordFor(input.organizationId, input.creativeId, attempt);
    const taken = await sql<{ id: string }>`
      select id from reel_attributions where organization_id = ${input.organizationId} and dm_keyword = ${dmKeyword} limit 1
    `;
    if (taken[0]) continue;
    const inserted = await sql<{ id: string }>`
      insert into reel_attributions (
        id, organization_id, brand_id, creative_id, utm_source, utm_medium, utm_campaign, utm_content, dm_keyword, destination_url, link_url
      ) values (
        ${crypto.randomUUID()}, ${input.organizationId}, ${input.brandId}, ${input.creativeId}, 'meridian', 'reel',
        ${utmCampaign}, ${utmContent}, ${dmKeyword}, ${destination || null}, ${linkUrl}
      )
      on conflict do nothing
      returning id
    `;
    if (inserted[0]) {
      return {
        creativeId: input.creativeId,
        dmKeyword,
        utmSource: "meridian",
        utmMedium: "reel",
        utmCampaign,
        utmContent,
        destinationUrl: destination || null,
        linkUrl,
        reason: linkUrl ? null : "No product URL is set for this brand, so the reel has a keyword but no link.",
      };
    }
    // Either another call created this reel's row at the same moment (returned below), or the keyword was taken in between.
    const created = await readAttribution(sql, input.organizationId, input.creativeId);
    if (created) return created;
  }
  throw new Error("No free DM keyword could be reserved for this reel. Nothing was attributed.");
}
