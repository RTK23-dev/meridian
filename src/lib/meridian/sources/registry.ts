/**
 * Universal Source Fabric Registry
 *
 * Central registry for all platform and file source adapters.
 */

import type { SourceAdapter, SourceHealth } from "./types.ts";
import { UploadSourceAdapter } from "./adapters/upload.ts";
import { InstagramSourceAdapter } from "./adapters/instagram.ts";
import { MetaAdLibrarySourceAdapter } from "./adapters/meta-ad-library.ts";
import { TikTokSourceAdapter } from "./adapters/tiktok.ts";
import { YouTubeSourceAdapter } from "./adapters/youtube.ts";
import { WebsiteSourceAdapter } from "./adapters/website.ts";
import { SearchSourceAdapter } from "./adapters/search.ts";
import { LicensedSourceAdapter } from "./adapters/licensed.ts";
import { FirstPartyAnalyticsSourceAdapter } from "./adapters/first-party-analytics.ts";
import { TwitterSourceAdapter } from "./adapters/twitter.ts";
import { FacebookSourceAdapter } from "./adapters/facebook.ts";
import { PinterestSourceAdapter } from "./adapters/pinterest.ts";
import { RedditSourceAdapter } from "./adapters/reddit.ts";
import { LinkedInSourceAdapter } from "./adapters/linkedin.ts";

export class SourceRegistry {
  private readonly adapters = new Map<string, SourceAdapter>();

  constructor() {
    this.register(new UploadSourceAdapter());
    this.register(new InstagramSourceAdapter());
    this.register(new MetaAdLibrarySourceAdapter());
    this.register(new TikTokSourceAdapter());
    this.register(new YouTubeSourceAdapter());
    this.register(new TwitterSourceAdapter());
    this.register(new FacebookSourceAdapter());
    this.register(new PinterestSourceAdapter());
    this.register(new RedditSourceAdapter());
    this.register(new LinkedInSourceAdapter());
    this.register(new WebsiteSourceAdapter());
    this.register(new SearchSourceAdapter());
    this.register(new LicensedSourceAdapter());
    this.register(new FirstPartyAnalyticsSourceAdapter());
  }

  register(adapter: SourceAdapter): void {
    this.adapters.set(adapter.id, adapter);
    this.adapters.set(adapter.platform, adapter);
  }

  get(idOrPlatform: string): SourceAdapter | undefined {
    return this.adapters.get(idOrPlatform);
  }

  list(): SourceAdapter[] {
    const unique = new Set<SourceAdapter>(this.adapters.values());
    return Array.from(unique);
  }

  async checkHealth(): Promise<SourceHealth[]> {
    const results: SourceHealth[] = [];
    for (const adapter of this.list()) {
      try {
        const h = await adapter.health();
        results.push(h);
      } catch (err) {
        results.push({
          adapterId: adapter.id,
          status: "UNAVAILABLE",
          latencyMs: 0,
          message: err instanceof Error ? err.message : String(err),
          lastCheckedAt: new Date().toISOString(),
        });
      }
    }
    return results;
  }
}

export const sourceRegistry = new SourceRegistry();
