/**
 * Search Engine Source Adapter
 *
 * Discovers market insights and competitor pages via configured search APIs (SerpApi / Google Custom Search).
 * Returns NOT_CONFIGURED when no key is saved, with the resolver's reason. A saved key is NOT_SUPPORTED in this release:
 * no search request is made, so no result is produced and none is invented.
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
      status: "NOT_SUPPORTED",
      latencyMs: 0,
      message: "A search key is saved, but this release does not run search queries. No results are produced from it.",
      lastCheckedAt: new Date().toISOString(),
    };
  }

  /** No search request is made in this release, so there are no results. The adapter never invents a reference. */
  async discover(_query: DiscoveryQuery): Promise<SourceReference[]> {
    return [];
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
