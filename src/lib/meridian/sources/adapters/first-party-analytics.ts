/**
 * First-Party Analytics Source Adapter
 *
 * Ingests first-party performance telemetry (Meta Ads Insights, TikTok Ads Manager, Shopify, GA4)
 * into the source fabric for calibration and outlier comparison.
 */

import { sourceKeyFor } from "../credentials.ts";
import type {
  SourceAdapter,
  SourceCapabilities,
  SourceReference,
  RawArtifact,
  SourceSnapshot,
  SourceHealth,
  DiscoveryQuery,
} from "../types.ts";

export class FirstPartyAnalyticsSourceAdapter implements SourceAdapter {
  readonly id = "first_party_analytics";
  readonly platform = "first_party_analytics" as const;
  readonly capabilities: SourceCapabilities = {
    profileDiscovery: false,
    contentDiscovery: true,
    metadata: true,
    videos: false,
    images: false,
    comments: false,
    performance: true,
    webpages: false,
    search: false,
  };

  async health(organizationId?: string): Promise<SourceHealth> {
    const meta = await sourceKeyFor("meta_graph", organizationId);
    const tiktok = await sourceKeyFor("tiktok", organizationId);

    if (!meta.secret && !tiktok.secret) {
      return {
        adapterId: this.id,
        status: "NOT_CONFIGURED",
        latencyMs: 0,
        message: meta.reason || tiktok.reason,
        lastCheckedAt: new Date().toISOString(),
      };
    }

    // A platform key is saved, but this release does not read campaign data with it, so nothing runs from it.
    return {
      adapterId: this.id,
      status: "NOT_SUPPORTED",
      latencyMs: 0,
      message: "A platform key is saved, but this release does not read first-party campaign data. No records are produced from it.",
      lastCheckedAt: new Date().toISOString(),
    };
  }

  /** No campaign read is made in this release, so there are no references. The adapter never invents one. */
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
        platform: "first_party_analytics",
        id: reference.externalId,
        fetchedAt: new Date().toISOString(),
      },
      capturedAt: new Date().toISOString(),
    };
  }

  async snapshot(reference: SourceReference): Promise<SourceSnapshot> {
    return {
      sourceId: reference.sourceId,
      platform: "first_party_analytics",
      metrics: {
        views: typeof reference.metadata?.impressions === "number" ? reference.metadata.impressions : undefined,
        reach: typeof reference.metadata?.reach === "number" ? reference.metadata.reach : undefined,
      },
      capturedAt: new Date().toISOString(),
    };
  }
}
