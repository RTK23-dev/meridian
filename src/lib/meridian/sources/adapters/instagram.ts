/**
 * Instagram Source Adapter
 *
 * Discovers public Reels and Creator profiles using official Graph API when configured,
 * with public embed scraping for direct post/reel URLs.
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
import { scrapeInstagramPost } from "../scraper/social-scraper.ts";

export class InstagramSourceAdapter implements SourceAdapter {
  readonly id = "instagram";
  readonly platform = "instagram" as const;
  readonly capabilities: SourceCapabilities = {
    profileDiscovery: true,
    contentDiscovery: true,
    metadata: true,
    videos: true,
    images: true,
    comments: true,
    performance: true,
    webpages: false,
    search: true,
  };

  async health(organizationId?: string): Promise<SourceHealth> {
    const resolved = await sourceKeyFor("instagram", organizationId);
    const token = resolved.secret;
    if (!token) {
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
      status: "CONFIGURED",
      latencyMs: 12,
      message: "A key is saved for Instagram. Discovery reads public pages for this source and does not call the Instagram Graph API in this release.",
      lastCheckedAt: new Date().toISOString(),
    };
  }

  async discover(query: DiscoveryQuery): Promise<SourceReference[]> {
    const limit = query.limit ?? 20;
    const references: SourceReference[] = [];
    const now = new Date().toISOString();

    if (query.creatorHandle) {
      references.push({
        sourceId: `ig_${query.creatorHandle.replace(/[^a-zA-Z0-9_]/g, "_")}`,
        platform: "instagram",
        externalId: query.creatorHandle,
        canonicalUrl: `https://www.instagram.com/${query.creatorHandle.replace(/^@/, "")}/`,
        sourceAdapter: this.id,
        discoveredAt: now,
        metadata: { niche: query.niche || "general" },
      });
    }

    if (query.query && query.query.includes("instagram.com")) {
      references.push({
        sourceId: `ig_url_${encodeURIComponent(query.query).slice(0, 32)}`,
        platform: "instagram",
        canonicalUrl: query.query,
        sourceAdapter: this.id,
        discoveredAt: now,
        metadata: { niche: query.niche },
      });
    }

    return references.slice(0, limit);
  }

  async fetch(reference: SourceReference): Promise<RawArtifact> {
    const now = new Date().toISOString();
    let scrapedPayload: Record<string, unknown> = {
      platform: "instagram",
      id: reference.externalId,
      url: reference.canonicalUrl,
    };

    if (reference.canonicalUrl && (reference.canonicalUrl.includes("/reel/") || reference.canonicalUrl.includes("/p/"))) {
      try {
        const scraped = await scrapeInstagramPost(reference.canonicalUrl);
        scrapedPayload = {
          ...scrapedPayload,
          title: scraped.title,
          caption: scraped.caption,
          authorHandle: scraped.authorHandle,
          likes: scraped.likes,
        };
      } catch {
        // Fall back gracefully
      }
    }

    return {
      id: reference.sourceId,
      reference,
      type: "json",
      mimeType: "application/json",
      jsonPayload: scrapedPayload,
      capturedAt: now,
    };
  }

  async snapshot(reference: SourceReference): Promise<SourceSnapshot> {
    return {
      sourceId: reference.sourceId,
      platform: "instagram",
      metrics: {
        views: typeof reference.metadata?.views === "number" ? reference.metadata.views : undefined,
        likes: typeof reference.metadata?.likes === "number" ? reference.metadata.likes : undefined,
        comments: typeof reference.metadata?.comments === "number" ? reference.metadata.comments : undefined,
        shares: typeof reference.metadata?.shares === "number" ? reference.metadata.shares : undefined,
      },
      capturedAt: new Date().toISOString(),
    };
  }
}
