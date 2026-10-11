/**
 * Twitter / X Source Adapter
 *
 * Discovers and ingests public tweets and video posts via official API when configured,
 * or via public oEmbed / scraping for direct URLs.
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
import { scrapeTwitterPost } from "../scraper/social-scraper.ts";

export class TwitterSourceAdapter implements SourceAdapter {
  readonly id = "twitter";
  readonly platform = "twitter" as const;
  readonly capabilities: SourceCapabilities = {
    profileDiscovery: true,
    contentDiscovery: true,
    metadata: true,
    videos: true,
    images: true,
    comments: false,
    performance: true,
    webpages: false,
    search: true,
  };

  async health(organizationId?: string): Promise<SourceHealth> {
    const resolved = await sourceKeyFor("twitter", organizationId);
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
      latencyMs: 15,
      message: "A key is saved for X (Twitter). Discovery reads public pages for this source and does not call the X API in this release.",
      lastCheckedAt: new Date().toISOString(),
    };
  }

  async discover(query: DiscoveryQuery): Promise<SourceReference[]> {
    const limit = query.limit ?? 20;
    const references: SourceReference[] = [];

    if (query.creatorHandle) {
      const canonicalUrl = `https://twitter.com/${query.creatorHandle.replace(/^@/, "")}`;
      references.push({
        sourceId: `tw_user_${query.creatorHandle}`,
        platform: "twitter",
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
        id: `tw_art_${reference.sourceId}`,
        reference,
        type: "json",
        mimeType: "application/json",
        jsonPayload: { status: "missing_url" },
        capturedAt: now,
      };
    }

    const scraped = await scrapeTwitterPost(reference.canonicalUrl);
    return {
      id: `tw_art_${reference.sourceId}`,
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
        platform: "twitter",
        metrics: {},
        capturedAt: now,
      };
    }

    const scraped = await scrapeTwitterPost(reference.canonicalUrl);
    return {
      sourceId: reference.sourceId,
      platform: "twitter",
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
