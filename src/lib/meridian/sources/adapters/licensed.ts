/**
 * Licensed Data Source Adapter
 *
 * Ingests intelligence from licensed platforms (e.g. Sensor Tower, Data.ai) when configured.
 * Reports explicit NOT_CONFIGURED when API credentials are absent.
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

export class LicensedSourceAdapter implements SourceAdapter {
  readonly id = "licensed";
  readonly platform = "licensed" as const;
  readonly capabilities: SourceCapabilities = {
    profileDiscovery: false,
    contentDiscovery: true,
    metadata: true,
    videos: false,
    images: false,
    comments: false,
    performance: true,
    webpages: false,
    search: true,
  };

  async health(organizationId?: string): Promise<SourceHealth> {
    const resolved = await sourceKeyFor("licensed", organizationId);
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
    // A key is saved, but no licensed-provider client exists in this release, so the source cannot run.
    return {
      adapterId: this.id,
      status: "NOT_SUPPORTED",
      latencyMs: 0,
      message: "A licensed-data key is saved, but this release has no client for that provider. No records are produced from it.",
      lastCheckedAt: new Date().toISOString(),
    };
  }

  /** No provider request is made in this release, so there are no records. The adapter never invents a reference. */
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
        platform: "licensed",
        advertiser: reference.metadata?.advertiser,
        fetchedAt: new Date().toISOString(),
      },
      capturedAt: new Date().toISOString(),
    };
  }
}
