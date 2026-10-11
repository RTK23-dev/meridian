/**
 * Reddit Source Adapter
 *
 * Discovers and ingests public Reddit submissions, video clips, and comment discussions.
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
import { scrapeRedditPost } from "../scraper/social-scraper.ts";

export class RedditSourceAdapter implements SourceAdapter {
  readonly id = "reddit";
  readonly platform = "reddit" as const;
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

  /**
   * The Reddit API is not connected in this release: no OAuth client is held, so the API reports NOT_CONFIGURED. Direct post
   * URLs are still read from their public pages, and the message says so instead of claiming an API connection.
   */
  async health(): Promise<SourceHealth> {
    return {
      adapterId: this.id,
      status: "NOT_CONFIGURED",
      latencyMs: 0,
      message: "The Reddit API is not connected. Direct post URLs can still be read from their public pages.",
      lastCheckedAt: new Date().toISOString(),
    };
  }

  async discover(query: DiscoveryQuery): Promise<SourceReference[]> {
    const limit = query.limit ?? 20;
    const references: SourceReference[] = [];

    if (query.niche) {
      const canonicalUrl = `https://www.reddit.com/r/${query.niche}/hot`;
      references.push({
        sourceId: `reddit_sub_${query.niche}`,
        platform: "reddit",
        canonicalUrl,
        sourceAdapter: this.id,
        discoveredAt: new Date().toISOString(),
        metadata: { subreddit: query.niche },
      });
    }

    return references.slice(0, limit);
  }

  async fetch(reference: SourceReference): Promise<RawArtifact> {
    const now = new Date().toISOString();
    if (!reference.canonicalUrl) {
      return {
        id: `reddit_art_${reference.sourceId}`,
        reference,
        type: "json",
        mimeType: "application/json",
        jsonPayload: { status: "missing_url" },
        capturedAt: now,
      };
    }

    const scraped = await scrapeRedditPost(reference.canonicalUrl);
    return {
      id: `reddit_art_${reference.sourceId}`,
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
        platform: "reddit",
        metrics: {},
        capturedAt: now,
      };
    }

    const scraped = await scrapeRedditPost(reference.canonicalUrl);
    return {
      sourceId: reference.sourceId,
      platform: "reddit",
      metrics: {
        likes: scraped.likes,
        comments: scraped.comments,
        views: scraped.views,
      },
      capturedAt: now,
    };
  }
}
