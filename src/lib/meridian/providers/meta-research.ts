import { sendWithRetry, type Transport } from "./http.ts";

const GRAPH = "https://graph.facebook.com/v21.0";

export type MetaLibraryAd = {
  externalId: string;
  pageId: string;
  advertiser: string;
  snapshotUrl: string;
  snapshotRequestUrl: string;
  capturedAt: string;
  publishedAt: string | null;
  copy: string;
  headline: string;
  description: string;
  platforms: string[];
  mediaType: "VIDEO" | "IMAGE" | "OTHER";
};

export type MetaLibraryResult =
  | { status: "CONNECTED"; ads: MetaLibraryAd[]; error: "" }
  | { status: "NOT_CONNECTED" | "FAILED"; ads: []; error: string };

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
function first(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map(text).find((item) => item.trim())?.trim() ?? "";
}

function parseAd(value: unknown, capturedAt: string): MetaLibraryAd | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const externalId = text(row.ad_archive_id) || text(row.id);
  const advertiser = text(row.page_name).trim();
  const snapshotUrl = text(row.ad_snapshot_url).trim();
  if (!externalId || !advertiser || !snapshotUrl) return null;
  let snapshot: URL;
  try { snapshot = new URL(snapshotUrl); } catch { return null; }
  if (snapshot.protocol !== "https:" || !["facebook.com", "www.facebook.com"].includes(snapshot.hostname)) return null;
  const snapshotRequestUrl = snapshot.toString();
  snapshot.searchParams.delete("access_token");
  const rawPlatforms = row.publisher_platforms;
  return {
    externalId,
    pageId: text(row.page_id),
    advertiser,
    snapshotUrl: snapshot.toString(),
    snapshotRequestUrl,
    capturedAt,
    publishedAt: text(row.ad_delivery_start_time) || null,
    copy: first(row.ad_creative_bodies),
    headline: first(row.ad_creative_link_titles),
    description: first(row.ad_creative_link_descriptions),
    platforms: Array.isArray(rawPlatforms) ? rawPlatforms.map(text).filter(Boolean).slice(0, 8) : [],
    // The request itself is filtered with media_type=VIDEO; Meta does not return that filter as a field.
    mediaType: "VIDEO",
  };
}

/** Bounded Meta Ad Library collection. Untrusted paging links are never followed. */
export async function collectMetaAdLibrary(input: {
  token?: string;
  searchTerms: string;
  country: string;
  limit?: number;
  capturedAt?: string;
  transport: Transport;
}): Promise<MetaLibraryResult> {
  const token = input.token?.trim() ?? "";
  if (!token) return { status: "NOT_CONNECTED", ads: [], error: "META_AD_LIBRARY_TOKEN is not configured. No ads were collected." };
  const searchTerms = input.searchTerms.trim();
  const country = input.country.trim().toUpperCase();
  if (!searchTerms || !/^[A-Z]{2}$/.test(country)) return { status: "FAILED", ads: [], error: "A search term and two-letter country are required." };
  if (searchTerms.length > 100) return { status: "FAILED", ads: [], error: "Meta Ad Library search terms are limited to 100 characters." };
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 50)));
  const capturedAt = input.capturedAt ?? new Date().toISOString();
  const params = new URLSearchParams({
    search_terms: searchTerms,
    ad_reached_countries: JSON.stringify([country]),
    ad_type: "ALL",
    media_type: "VIDEO",
    fields: "id,page_id,page_name,ad_snapshot_url,ad_delivery_start_time,ad_creative_bodies,ad_creative_link_titles,ad_creative_link_descriptions,publisher_platforms",
    limit: String(Math.min(limit, 25)),
  });
  const collected: MetaLibraryAd[] = [];
  let after: string | null = null;
  const pages = Math.ceil(limit / 25);
  for (let page = 0; page < pages; page += 1) {
    if (page > 0 && !after) break;
    if (after) params.set("after", after);
    const response = await sendWithRetry(input.transport, {
      method: "GET",
      url: `${GRAPH}/ads_archive?${params.toString()}`,
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
    });
    if (!response.ok) return { status: "FAILED", ads: [], error: response.error || "Meta Ad Library collection failed." };
    if (!response.json || typeof response.json !== "object") return { status: "FAILED", ads: [], error: "Meta returned an invalid Ad Library response." };
    const body = response.json as { data?: unknown; paging?: { cursors?: { after?: string } } };
    if (!Array.isArray(body.data)) return { status: "FAILED", ads: [], error: "Meta Ad Library response did not include ads." };
    for (const row of body.data) {
      const ad = parseAd(row, capturedAt);
      if (ad) collected.push(ad);
      if (collected.length >= limit) break;
    }
    if (collected.length >= limit) break;
    after = body.paging?.cursors?.after ?? null;
  }
  const unique = [...new Map(collected.map((ad) => [ad.externalId, ad])).values()].slice(0, limit);
  return { status: "CONNECTED", ads: unique, error: "" };
}
