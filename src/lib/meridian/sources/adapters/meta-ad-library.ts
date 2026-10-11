/**
 * Meta Ad Library Source Adapter
 *
 * Searches public ads through the Meta Ad Library API (ads_archive) with the workspace's saved token, for a search phrase
 * and a country. Each ad is kept as a reference: its id, its Ad Library URL (built from the id, so the snapshot URL and its
 * access token are never stored), the advertiser's name and the start date. Nothing else is stored.
 *
 * Never fabricates ad records when disconnected: without a saved token there is no request and no ad.
 */

import { sourceKeyFor } from "../credentials.ts";
import {
  boundedInt,
  clipText,
  connectionHealth,
  getSourceJson,
  isoTimeOf,
  notConfiguredHealth,
  providerErrorCode,
  recordOf,
  SourceCallError,
  transportOf,
  type CallFailure,
  type SourceFetch,
} from "../live-api.ts";
import type {
  SourceAdapter,
  SourceCapabilities,
  SourceReference,
  RawArtifact,
  SourceHealth,
  DiscoveryQuery,
} from "../types.ts";

const META_GRAPH = "https://graph.facebook.com/v21.0";

/** Graph error codes for a rate limit. Code 190 is an invalid or expired token. */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);
const INVALID_TOKEN_CODE = 190;

function metaFailure(body: unknown): CallFailure | undefined {
  const code = providerErrorCode(body);
  if (code === INVALID_TOKEN_CODE) return "AUTH_FAILED";
  if (typeof code === "number" && RATE_LIMIT_CODES.has(code)) return "RATE_LIMITED";
  return undefined;
}

/** Two letters, upper case. Anything else falls back to the United States. */
function countryOf(value: string | undefined): string {
  const country = value?.trim().toUpperCase() ?? "";
  return /^[A-Z]{2}$/.test(country) ? country : "US";
}

function adsArchiveUrl(searchTerms: string, country: string, limit: number): string {
  const params = new URLSearchParams({
    search_terms: searchTerms,
    ad_reached_countries: JSON.stringify([country]),
    ad_type: "ALL",
    fields: "id,page_name,ad_delivery_start_time",
    limit: String(limit),
  });
  return `${META_GRAPH}/ads_archive?${params.toString()}`;
}

export class MetaAdLibrarySourceAdapter implements SourceAdapter {
  readonly id = "meta_ad_library";
  readonly platform = "meta_ad_library" as const;
  readonly capabilities: SourceCapabilities = {
    profileDiscovery: false,
    contentDiscovery: true,
    metadata: true,
    videos: false,
    images: true,
    comments: false,
    performance: false,
    webpages: false,
    search: true,
  };

  private readonly transport: SourceFetch | undefined;

  /** The transport is injected by tests. Without one, requests use the platform's fetch. */
  constructor(options: { fetch?: SourceFetch } = {}) {
    this.transport = options.fetch;
  }

  async health(organizationId?: string): Promise<SourceHealth> {
    const resolved = await sourceKeyFor("meta_ad_library", organizationId);
    if (!resolved.secret) return notConfiguredHealth(this.id, resolved.reason);
    return {
      adapterId: this.id,
      status: "CONFIGURED",
      latencyMs: 15,
      message: "A key is saved for Meta Ad Library. Discovery searches public ads with it when a search phrase is given. The key is checked when a request is made. The research collection job reports its own status.",
      lastCheckedAt: new Date().toISOString(),
    };
  }

  /** One request for a single ad, run only when someone asks to test the connection. The response is not stored. */
  async testConnection(organizationId?: string): Promise<SourceHealth> {
    const resolved = await sourceKeyFor("meta_ad_library", organizationId);
    const token = resolved.secret;
    if (!token) return notConfiguredHealth(this.id, resolved.reason);
    return connectionHealth({
      adapterId: this.id,
      source: "Meta Ad Library",
      check: () => getSourceJson({
        source: "Meta Ad Library",
        fetch: transportOf(this.transport),
        url: adsArchiveUrl("test", "US", 1),
        headers: { authorization: `Bearer ${token}` },
        classify: metaFailure,
      }),
    });
  }

  async discover(query: DiscoveryQuery): Promise<SourceReference[]> {
    const resolved = await sourceKeyFor("meta_ad_library", query.organizationId);
    const token = resolved.secret;
    if (!token) return [];
    const searchTerms = (query.query ?? query.advertiser ?? "").trim().slice(0, 100);
    if (!searchTerms) return [];

    const body = await getSourceJson({
      source: "Meta Ad Library",
      fetch: transportOf(this.transport),
      url: adsArchiveUrl(searchTerms, countryOf(query.country), boundedInt(query.limit, 1, 25, 10)),
      headers: { authorization: `Bearer ${token}` },
      classify: metaFailure,
    });
    if (!Array.isArray(body.data)) {
      throw new SourceCallError("UNAVAILABLE", "Meta Ad Library returned a response without ads. No results were read.");
    }

    const discoveredAt = new Date().toISOString();
    const seen = new Set<string>();
    const references: SourceReference[] = [];
    for (const item of body.data) {
      const row = recordOf(item);
      const adId = typeof row?.id === "string" ? row.id : "";
      if (!/^\d{6,30}$/.test(adId) || seen.has(adId)) continue;
      seen.add(adId);
      references.push({
        sourceId: `meta_ad_${adId}`,
        platform: "meta_ad_library",
        externalId: adId,
        canonicalUrl: `https://www.facebook.com/ads/library/?id=${adId}`,
        sourceAdapter: this.id,
        discoveredAt,
        metadata: {
          title: clipText(row?.page_name, 200),
          publishedAt: isoTimeOf(row?.ad_delivery_start_time),
        },
      });
    }
    return references;
  }

  async fetch(reference: SourceReference): Promise<RawArtifact> {
    return {
      id: reference.sourceId,
      reference,
      type: "json",
      mimeType: "application/json",
      jsonPayload: {
        platform: "meta_ad_library",
        advertiser: reference.externalId,
        canonicalUrl: reference.canonicalUrl,
        fetchedAt: new Date().toISOString(),
      },
      capturedAt: new Date().toISOString(),
    };
  }
}
