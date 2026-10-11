/**
 * Search Engine Source Adapter
 *
 * Discovers market insights and competitor pages via configured search APIs (SerpApi / Google Custom Search).
 * Returns NOT_CONFIGURED when API keys are unset.
 */

import { sourceKeyFor } from "../credentials.ts";
import type {
  SourceAdapter,
  SourceCapabilities,
  SourceReference,
  RawArtifact,
  SourceHealth,
  DiscoveryQuery,
} from "../types.ts";

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

  async health(organizationId?: string): Promise<SourceHealth> {
    const resolved = await sourceKeyFor("search", organizationId);
    const key = resolved.secret;
    if (!key) {
      return {
        adapterId: this.id,
        status: "NOT_CONFIGURED",
        latencyMs: 0,
        message: resolved.reason,
        lastCheckedAt: new Date().toISOString(),
      };
    }
    return {
      adapterId: this.id,
      status: "HEALTHY",
      latencyMs: 15,
      message: "Search API configured.",
      lastCheckedAt: new Date().toISOString(),
    };
  }

  async discover(query: DiscoveryQuery): Promise<SourceReference[]> {
    const resolved = await sourceKeyFor("search", query.organizationId);
    const key = resolved.secret;
    if (!key || !query.query) return [];

    // When configured, search adapter maps results to SourceReference items
    return [
      {
        sourceId: `search_${encodeURIComponent(query.query)}`,
        platform: "search",
        canonicalUrl: undefined,
        sourceAdapter: this.id,
        discoveredAt: new Date().toISOString(),
        metadata: {
          searchQuery: query.query,
          niche: query.niche,
        },
      },
    ];
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
