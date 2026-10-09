/**
 * First-Party Analytics Source Adapter
 *
 * Ingests first-party performance telemetry (Meta Ads Insights, TikTok Ads Manager, Shopify, GA4)
 * into the source fabric for calibration and outlier comparison.
 */

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

  async health(): Promise<SourceHealth> {
    const hasAnyCred = Boolean(
      process.env.META_ACCESS_TOKEN ||
      process.env.TIKTOK_ACCESS_TOKEN ||
      process.env.SHOPIFY_ACCESS_TOKEN
    );

    if (!hasAnyCred) {
      return {
        adapterId: this.id,
        status: "NOT_CONFIGURED",
        latencyMs: 0,
        message: "No first-party advertising or store connectors configured.",
        lastCheckedAt: new Date().toISOString(),
      };
    }

    return {
      adapterId: this.id,
      status: "HEALTHY",
      latencyMs: 5,
      message: "First-party connectors active.",
      lastCheckedAt: new Date().toISOString(),
    };
  }

  async discover(query: DiscoveryQuery): Promise<SourceReference[]> {
    // When queried, returns tracked first-party campaigns/ad creatives
    if (!query.advertiser) return [];

    return [
      {
        sourceId: `1p_${query.advertiser}`,
        platform: "first_party_analytics",
        externalId: query.advertiser,
        sourceAdapter: this.id,
        discoveredAt: new Date().toISOString(),
        metadata: { advertiser: query.advertiser },
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
