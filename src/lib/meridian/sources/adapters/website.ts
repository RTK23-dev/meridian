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

  async discover(query: DiscoveryQuery): Promise<SourceReference[]> {
    const rawTarget = query.query || "";
    if (!rawTarget) return [];

    let targetUrl = rawTarget.trim();
    if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
      targetUrl = `https://${targetUrl}`;
    }

    try {
      const { crawlLadderPage } = await import("../../discovery/crawler.ts");
      const result = await crawlLadderPage(targetUrl, `disc_${Date.now()}`);
      const limit = query.limit || 20;

      const refs: SourceReference[] = [];

      // Add top-level page reference
      refs.push({
        sourceId: `web_${Buffer.from(result.canonicalUrl).toString("base64url").slice(0, 32)}`,
        platform: "website",
        sourceAdapter: this.id,
        canonicalUrl: result.canonicalUrl,
        discoveredAt: new Date().toISOString(),
      });

      // Add discovered repeated cards
      for (const card of result.cards) {
        if (refs.length >= limit) break;
        if (card.destinationUrl) {
          refs.push({
            sourceId: `web_${Buffer.from(card.destinationUrl).toString("base64url").slice(0, 32)}`,
            platform: "website",
            sourceAdapter: this.id,
            canonicalUrl: card.destinationUrl,
            discoveredAt: card.discoveredAt,
          });
        }
      }

      // Add outbound discovered links
      for (const link of result.outboundLinks) {
        if (refs.length >= limit) break;
        if (!refs.some((r) => r.canonicalUrl === link)) {
          refs.push({
            sourceId: `web_${Buffer.from(link).toString("base64url").slice(0, 32)}`,
            platform: "website",
            sourceAdapter: this.id,
            canonicalUrl: link,
            discoveredAt: new Date().toISOString(),
          });
        }
      }

      return refs;
    } catch {
      return [];
    }
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
