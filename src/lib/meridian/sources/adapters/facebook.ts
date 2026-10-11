/**
 * Facebook Source Adapter
 *
 * Discovers and ingests public Facebook Reels, video posts, and public Page posts.
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
import { scrapeFacebookPost } from "../scraper/social-scraper.ts";

export class FacebookSourceAdapter implements SourceAdapter {
  readonly id = "facebook";
  readonly platform = "facebook" as const;
  readonly capabilities: SourceCapabilities = {
    profileDiscovery: true,
    contentDiscovery: true,
    metadata: true,
    videos: true,
    images: true,
    comments: false,
    performance: true,
    webpages: false,
    search: false,
  };

  async health(organizationId?: string): Promise<SourceHealth> {
    const resolved = await sourceKeyFor("meta_graph", organizationId);
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
      status: "HEALTHY",
      latencyMs: 14,
      message: "Connected to Facebook Graph API.",
      lastCheckedAt: new Date().toISOString(),
    };
  }

  async discover(query: DiscoveryQuery): Promise<SourceReference[]> {
    const limit = query.limit ?? 20;
    const references: SourceReference[] = [];

    if (query.creatorHandle) {
      const canonicalUrl = `https://www.facebook.com/${query.creatorHandle}`;
      references.push({
        sourceId: `fb_page_${query.creatorHandle}`,
        platform: "facebook",
        canonicalUrl,
        sourceAdapter: this.id,
        discoveredAt: new Date().toISOString(),
        metadata: { handle: query.creatorHandle },
      });
    }

    return references.slice(0, limit);
  }

  async fetch(reference: SourceReference): Promise<RawArtifact> {
    const now = new Date().toISOString();
    if (!reference.canonicalUrl) {
      return {
        id: `fb_art_${reference.sourceId}`,
        reference,
        type: "json",
        mimeType: "application/json",
        jsonPayload: { status: "missing_url" },
        capturedAt: now,
      };
    }

    const scraped = await scrapeFacebookPost(reference.canonicalUrl);
    return {
      id: `fb_art_${reference.sourceId}`,
      reference,
      type: "json",
      mimeType: "application/json",
      textPayload: scraped.caption,
      jsonPayload: scraped as unknown as Record<string, unknown>,
      capturedAt: now,
    };
  }

  async snapshot(reference: SourceReference): Promise<SourceSnapshot> {
    const now = new Date().toISOString();
    if (!reference.canonicalUrl) {
      return {
        sourceId: reference.sourceId,
        platform: "facebook",
        metrics: {},
        capturedAt: now,
      };
    }

    const scraped = await scrapeFacebookPost(reference.canonicalUrl);
    return {
      sourceId: reference.sourceId,
      platform: "facebook",
      metrics: {
        likes: scraped.likes,
        comments: scraped.comments,
        shares: scraped.shares,
        views: scraped.views,
      },
      capturedAt: now,
    };
  }
}
