/**
 * LinkedIn Source Adapter
 *
 * Discovers and ingests public LinkedIn company and creator posts.
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
import { scrapeLinkedInPost } from "../scraper/social-scraper.ts";

export class LinkedInSourceAdapter implements SourceAdapter {
  readonly id = "linkedin";
  readonly platform = "linkedin" as const;
  readonly capabilities: SourceCapabilities = {
    profileDiscovery: true,
    contentDiscovery: true,
    metadata: true,
    videos: true,
    images: true,
    comments: false,
    performance: false,
    webpages: false,
    search: false,
  };

  async health(organizationId?: string): Promise<SourceHealth> {
    const resolved = await sourceKeyFor("linkedin", organizationId);
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
      message: "A key is saved for LinkedIn. Discovery reads public pages for this source and does not call the LinkedIn API in this release.",
      lastCheckedAt: new Date().toISOString(),
    };
  }

  async discover(query: DiscoveryQuery): Promise<SourceReference[]> {
    const limit = query.limit ?? 20;
    const references: SourceReference[] = [];

    if (query.creatorHandle) {
      const canonicalUrl = `https://www.linkedin.com/in/${query.creatorHandle}`;
      references.push({
        sourceId: `li_user_${query.creatorHandle}`,
        platform: "linkedin",
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
        id: `li_art_${reference.sourceId}`,
        reference,
        type: "json",
        mimeType: "application/json",
        jsonPayload: { status: "missing_url" },
        capturedAt: now,
      };
    }

    const scraped = await scrapeLinkedInPost(reference.canonicalUrl);
    return {
      id: `li_art_${reference.sourceId}`,
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
        platform: "linkedin",
        metrics: {},
        capturedAt: now,
      };
    }

    const scraped = await scrapeLinkedInPost(reference.canonicalUrl);
    return {
      sourceId: reference.sourceId,
      platform: "linkedin",
      metrics: {
        likes: scraped.likes,
        comments: scraped.comments,
      },
      capturedAt: now,
    };
  }
}
