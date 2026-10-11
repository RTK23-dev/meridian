/**
 * YouTube Source Adapter
 *
 * Discovers public YouTube videos for a search phrase through the YouTube Data API v3 (search.list), using the workspace's
 * saved key. Each result is kept as a reference: its video id, watch URL, title and publish time. Nothing else from the
 * response is stored. A provider failure is raised as a SourceCallError, so the run records it; zero results is an empty
 * list. Source health reports key presence only. testConnection makes one request, and only when it is asked for.
 */

import { sourceKeyFor } from "../credentials.ts";
import {
  boundedInt,
  clipText,
  connectionHealth,
  getSourceJson,
  isoTimeOf,
  notConfiguredHealth,
  providerErrorReasons,
  recordOf,
  SourceCallError,
  transportOf,
  type CallFailure,
  type SourceFetch,
} from "../live-api.ts";
import type {
  SourceAdapter,
  SourceCapabilities,
  SourceReference,
  RawArtifact,
  SourceSnapshot,
  SourceHealth,
  DiscoveryQuery,
} from "../types.ts";
import { scrapeYouTubeShort } from "../scraper/social-scraper.ts";

const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";

/** Quota and rate reasons YouTube returns with HTTP 403. They are a rate limit, not a rejected key. */
const QUOTA_REASONS = new Set(["quotaExceeded", "rateLimitExceeded", "dailyLimitExceeded", "userRateLimitExceeded"]);

function youtubeFailure(body: unknown): CallFailure | undefined {
  const reasons = providerErrorReasons(body);
  if (reasons.some((reason) => QUOTA_REASONS.has(reason))) return "RATE_LIMITED";
  if (reasons.includes("keyInvalid")) return "AUTH_FAILED";
  return undefined;
}

function videoIdOf(item: unknown): string | undefined {
  const id = recordOf(recordOf(item)?.id)?.videoId;
  return typeof id === "string" && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : undefined;
}

export class YouTubeSourceAdapter implements SourceAdapter {
  readonly id = "youtube";
  readonly platform = "youtube" as const;
  readonly capabilities: SourceCapabilities = {
    profileDiscovery: true,
    contentDiscovery: true,
    metadata: true,
    videos: false,
    images: false,
    comments: false,
    performance: true,
    webpages: false,
    search: true,
  };

  private readonly transport: SourceFetch | undefined;

  /** The transport is injected by tests. Without one, requests use the platform's fetch. */
  constructor(options: { fetch?: SourceFetch } = {}) {
    this.transport = options.fetch;
  }

  async health(organizationId?: string): Promise<SourceHealth> {
    const resolved = await sourceKeyFor("youtube", organizationId);
    if (!resolved.secret) return notConfiguredHealth(this.id, resolved.reason);
    return {
      adapterId: this.id,
      status: "CONFIGURED",
      latencyMs: 15,
      message: "A key is saved for YouTube. Discovery searches public videos with it when a search phrase is given. The key is checked when a request is made.",
      lastCheckedAt: new Date().toISOString(),
    };
  }

  /**
   * Makes one minimal request with the workspace's key. It is run only when someone asks to test the connection. It never
   * stores the response.
   */
  async testConnection(organizationId?: string): Promise<SourceHealth> {
    const resolved = await sourceKeyFor("youtube", organizationId);
    const apiKey = resolved.secret;
    if (!apiKey) return notConfiguredHealth(this.id, resolved.reason);
    return connectionHealth({
      adapterId: this.id,
      source: "YouTube",
      check: () => getSourceJson({
        source: "YouTube",
        fetch: transportOf(this.transport),
        url: `${YOUTUBE_API}/videoCategories?${new URLSearchParams({ part: "id", regionCode: "US", key: apiKey }).toString()}`,
        classify: youtubeFailure,
      }),
    });
  }

  /**
   * Videos for the query's phrase, from the workspace's key. No key means no request and an empty list. A creator handle or
   * a YouTube URL in the query is kept as a reference without a request, the same as before.
   */
  async discover(query: DiscoveryQuery): Promise<SourceReference[]> {
    const resolved = await sourceKeyFor("youtube", query.organizationId);
    const apiKey = resolved.secret;
    if (!apiKey) return [];

    const limit = boundedInt(query.limit, 1, 50, 20);
    const now = new Date().toISOString();
    const references: SourceReference[] = [];

    if (query.creatorHandle) {
      references.push({
        sourceId: `yt_${query.creatorHandle.replace(/[^a-zA-Z0-9_]/g, "_")}`,
        platform: "youtube",
        externalId: query.creatorHandle,
        canonicalUrl: `https://www.youtube.com/@${query.creatorHandle.replace(/^@/, "")}`,
        sourceAdapter: this.id,
        discoveredAt: now,
        metadata: { niche: query.niche || "general" },
      });
    }

    const phrase = query.query?.trim() ?? "";
    if (phrase && (phrase.includes("youtube.com") || phrase.includes("youtu.be"))) {
      references.push({
        sourceId: `yt_url_${encodeURIComponent(phrase).slice(0, 32)}`,
        platform: "youtube",
        canonicalUrl: phrase,
        sourceAdapter: this.id,
        discoveredAt: now,
        metadata: { niche: query.niche },
      });
    } else if (phrase) {
      references.push(...(await this.searchVideos(phrase, apiKey, query, limit, now)));
    }

    return references.slice(0, limit);
  }

  private async searchVideos(
    phrase: string,
    apiKey: string,
    query: DiscoveryQuery,
    limit: number,
    discoveredAt: string,
  ): Promise<SourceReference[]> {
    const params = new URLSearchParams({
      part: "snippet",
      type: "video",
      q: phrase.slice(0, 200),
      maxResults: String(limit),
      key: apiKey,
    });
    const since = isoTimeOf(query.since);
    if (since) params.set("publishedAfter", since);
    const body = await getSourceJson({
      source: "YouTube",
      fetch: transportOf(this.transport),
      url: `${YOUTUBE_API}/search?${params.toString()}`,
      classify: youtubeFailure,
    });

    if (!Array.isArray(body.items)) {
      throw new SourceCallError("UNAVAILABLE", "YouTube returned a response without videos. No results were read.");
    }
    const items = body.items;
    const seen = new Set<string>();
    const references: SourceReference[] = [];
    for (const item of items) {
      const videoId = videoIdOf(item);
      if (!videoId || seen.has(videoId)) continue;
      seen.add(videoId);
      const snippet = recordOf(recordOf(item)?.snippet);
      references.push({
        sourceId: `yt_${videoId}`,
        platform: "youtube",
        externalId: videoId,
        canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
        sourceAdapter: this.id,
        discoveredAt,
        metadata: {
          title: clipText(snippet?.title, 200),
          publishedAt: isoTimeOf(snippet?.publishedAt),
        },
      });
    }
    return references;
  }

  async fetch(reference: SourceReference): Promise<RawArtifact> {
    const now = new Date().toISOString();
    let scrapedPayload: Record<string, unknown> = {
      platform: "youtube",
      id: reference.externalId,
      url: reference.canonicalUrl,
    };

    if (reference.canonicalUrl && (reference.canonicalUrl.includes("shorts") || reference.canonicalUrl.includes("watch"))) {
      try {
        const scraped = await scrapeYouTubeShort(reference.canonicalUrl);
        scrapedPayload = {
          ...scrapedPayload,
          title: scraped.title,
          authorName: scraped.authorName,
          thumbnailUrl: scraped.thumbnailUrl,
          views: scraped.views,
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
      platform: "youtube",
      metrics: {
        views: typeof reference.metadata?.views === "number" ? reference.metadata.views : undefined,
        likes: typeof reference.metadata?.likes === "number" ? reference.metadata.likes : undefined,
        comments: typeof reference.metadata?.comments === "number" ? reference.metadata.comments : undefined,
      },
      capturedAt: new Date().toISOString(),
    };
  }
}
