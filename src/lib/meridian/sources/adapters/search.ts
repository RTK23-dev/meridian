/**
 * Search Engine Source Adapter
 *
 * Discovers Google results for a search phrase through SerpAPI, using the workspace's saved search key. Each result is kept
 * as a reference: its canonical URL, a stable id derived from that URL, and its title. Nothing else is stored.
 *
 * The saved key is a SerpAPI key. A Google Custom Search key is a different credential and is refused by SerpAPI, which the
 * run then records as AUTH_FAILED. "No results" from SerpAPI is an empty list, not a failure.
 */

import { createHash } from "node:crypto";
import { sourceKeyFor } from "../credentials.ts";
import {
  boundedInt,
  clipText,
  connectionHealth,
  getSourceJson,
  notConfiguredHealth,
  recordOf,
  SourceCallError,
  transportOf,
  type SourceFetch,
} from "../live-api.ts";
import { normalizeCanonicalUrl } from "../../evidence/dedupe.ts";
import type {
  SourceAdapter,
  SourceCapabilities,
  SourceReference,
  RawArtifact,
  SourceHealth,
  DiscoveryQuery,
} from "../types.ts";

const SERPAPI = "https://serpapi.com";

/** SerpAPI answers a query that matched nothing with an error message and HTTP 200. That is an empty result. */
const NO_RESULTS = /hasn'?t returned any results|no results/i;

export class SearchSourceAdapter implements SourceAdapter {
  readonly id = "search";
  readonly platform = "search" as const;
  readonly capabilities: SourceCapabilities = {
    profileDiscovery: false,
    contentDiscovery: true,
    metadata: true,
    videos: false,
    images: false,
    comments: false,
    performance: false,
    webpages: true,
    search: true,
  };

  private readonly transport: SourceFetch | undefined;

  /** The transport is injected by tests. Without one, requests use the platform's fetch. */
  constructor(options: { fetch?: SourceFetch } = {}) {
    this.transport = options.fetch;
  }

  async health(organizationId?: string): Promise<SourceHealth> {
    const resolved = await sourceKeyFor("search", organizationId);
    if (!resolved.secret) return notConfiguredHealth(this.id, resolved.reason);
    return {
      adapterId: this.id,
      status: "CONFIGURED",
      latencyMs: 0,
      message: "A search key is saved. Discovery runs Google searches through SerpAPI with it. The key is checked when a request is made.",
      lastCheckedAt: new Date().toISOString(),
    };
  }

  /** One account request, which SerpAPI does not count as a search. Run only when someone asks to test the connection. */
  async testConnection(organizationId?: string): Promise<SourceHealth> {
    const resolved = await sourceKeyFor("search", organizationId);
    const apiKey = resolved.secret;
    if (!apiKey) return notConfiguredHealth(this.id, resolved.reason);
    return connectionHealth({
      adapterId: this.id,
      source: "SerpAPI",
      check: () => getSourceJson({
        source: "SerpAPI",
        fetch: transportOf(this.transport),
        url: `${SERPAPI}/account.json?${new URLSearchParams({ api_key: apiKey }).toString()}`,
      }),
    });
  }

  /** Google results for the query's phrase. No key, or no phrase, means no request and an empty list. */
  async discover(query: DiscoveryQuery): Promise<SourceReference[]> {
    const resolved = await sourceKeyFor("search", query.organizationId);
    const apiKey = resolved.secret;
    const phrase = query.query?.trim() ?? "";
    if (!apiKey || !phrase) return [];

    const params = new URLSearchParams({
      engine: "google",
      q: phrase.slice(0, 300),
      num: String(boundedInt(query.limit, 1, 100, 10)),
      api_key: apiKey,
    });
    const body = await getSourceJson({
      source: "SerpAPI",
      fetch: transportOf(this.transport),
      url: `${SERPAPI}/search.json?${params.toString()}`,
    });
    if (typeof body.error === "string" && !Array.isArray(body.organic_results)) {
      if (NO_RESULTS.test(body.error)) return [];
      throw new SourceCallError("UNAVAILABLE", "SerpAPI returned an error. No results were read.");
    }

    const organic = Array.isArray(body.organic_results) ? body.organic_results : [];
    const discoveredAt = new Date().toISOString();
    const seen = new Set<string>();
    const references: SourceReference[] = [];
    for (const result of organic) {
      const row = recordOf(result);
      const link = typeof row?.link === "string" ? row.link.trim() : "";
      if (!/^https?:\/\//i.test(link)) continue;
      const canonical = normalizeCanonicalUrl(link) ?? link;
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      references.push({
        sourceId: `serp_${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`,
        platform: "search",
        externalId: canonical,
        canonicalUrl: canonical,
        sourceAdapter: this.id,
        discoveredAt,
        metadata: { title: clipText(row?.title, 200) },
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
        platform: "search",
        query: reference.metadata?.searchQuery,
        fetchedAt: new Date().toISOString(),
      },
      capturedAt: new Date().toISOString(),
    };
  }
}
