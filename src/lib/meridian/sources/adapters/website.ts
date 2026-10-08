/**
 * Website Source Adapter
 *
 * Fetches public brand, competitor, or landing pages for positioning & claims analysis.
 * Uses strict SSRF prevention and does not bypass robot policies or authentication walls.
 */

import { fetchPublicText } from "../fetch-page.server.ts";
import { quarantineExternalText } from "../../ingestion/quarantine.ts";
import type {
  SourceAdapter,
  SourceCapabilities,
  SourceReference,
  RawArtifact,
  SourceHealth,
  DiscoveryQuery,
} from "../types.ts";

export class WebsiteSourceAdapter implements SourceAdapter {
  readonly id = "website";
  readonly platform = "website" as const;
  readonly capabilities: SourceCapabilities = {
    profileDiscovery: false,
    contentDiscovery: true,
    metadata: true,
    videos: false,
    images: true,
    comments: false,
    performance: false,
    webpages: true,
    search: false,
  };

  async health(): Promise<SourceHealth> {
    return {
      adapterId: this.id,
      status: "HEALTHY",
      latencyMs: 1,
      message: "Ready for public web page extraction.",
      lastCheckedAt: new Date().toISOString(),
    };
  }

  async discover(_query: DiscoveryQuery): Promise<SourceReference[]> {
    return [];
  }

  async fetch(reference: SourceReference): Promise<RawArtifact> {
    const url = reference.canonicalUrl || "";
    if (!url) throw new Error("Website adapter requires a canonical URL.");

    const page = await fetchPublicText(url);
    const cleaned = quarantineExternalText(page.text);

    return {
      id: reference.sourceId,
      reference,
      type: "html",
      mimeType: "text/html",
      textPayload: cleaned.text,
      jsonPayload: {
        finalUrl: page.url,
      },
      capturedAt: new Date().toISOString(),
    };
  }
}
