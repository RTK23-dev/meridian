/**
 * RSS and Atom feed source adapter.
 *
 * The feed is read through Meridian's public-document fetch, which checks DNS, robots.txt and bot challenges, and then parsed by
 * Agent Reach's RSS reader inside the sourcing sidecar. Each item's article is read through the same page path as the website
 * adapter, so its text is quarantined like any other untrusted page. Without the sidecar, the adapter reports that it is not
 * connected and reads nothing.
 */

import { fetchPublicFeed, fetchPublicText } from "../fetch-page.server.ts";
import { parseFeedWithSidecar, sidecarConfig, type SidecarConfig } from "../sidecar.server.ts";
import { publicUrlIssue } from "../public-url.ts";
import { quarantineExternalText } from "../../ingestion/quarantine.ts";
import type {
  DiscoveryQuery,
  RawArtifact,
  SourceAdapter,
  SourceCapabilities,
  SourceHealth,
  SourceReference,
} from "../types.ts";

export const FEED_NOT_CONNECTED =
  "Feeds need the sourcing sidecar. Set MERIDIAN_SOURCING_SIDECAR_URL and MERIDIAN_SIDECAR_TOKEN on the server to read them.";

type FeedDeps = {
  config?: SidecarConfig | null;
  fetchFeed?: typeof fetchPublicFeed;
  fetchImpl?: typeof fetch;
};

export class FeedSourceAdapter implements SourceAdapter {
  readonly id = "feed";
  readonly platform = "rss" as const;
  readonly capabilities: SourceCapabilities = {
    profileDiscovery: false,
    contentDiscovery: true,
    metadata: true,
    videos: false,
    images: false,
    comments: false,
    performance: false,
    webpages: true,
    search: false,
  };

  private readonly deps: FeedDeps;

  constructor(deps: FeedDeps = {}) {
    this.deps = deps;
  }

  private config(): SidecarConfig | null {
    return this.deps.config !== undefined ? this.deps.config : sidecarConfig();
  }

  async health(): Promise<SourceHealth> {
    const configured = this.config() !== null;
    return {
      adapterId: this.id,
      status: configured ? "HEALTHY" : "NOT_CONFIGURED",
      latencyMs: 1,
      message: configured ? "Ready to read RSS and Atom feeds through the sourcing sidecar." : FEED_NOT_CONNECTED,
      lastCheckedAt: new Date().toISOString(),
    };
  }

  /** One feed address per discovery. Each item in the feed becomes a reference to its article. */
  async discover(query: DiscoveryQuery): Promise<SourceReference[]> {
    const feedUrl = (query.query || "").trim();
    if (!feedUrl) return [];
    if (publicUrlIssue(feedUrl)) throw new Error("The feed address must be a public http or https URL.");
    const config = this.config();
    if (!config) throw new Error(FEED_NOT_CONNECTED);

    const limit = Math.min(query.limit || 20, 50);
    const fetchFeed = this.deps.fetchFeed ?? fetchPublicFeed;
    const feed = await fetchFeed(feedUrl);
    const parsed = await parseFeedWithSidecar(config, feed.feed, limit, this.deps.fetchImpl);
    if (!parsed) throw new Error("The sourcing sidecar could not read this feed. Nothing was stored.");

    const discoveredAt = new Date().toISOString();
    const seen = new Set<string>();
    const refs: SourceReference[] = [];
    for (const item of parsed.items) {
      if (refs.length >= limit || seen.has(item.link)) continue;
      seen.add(item.link);
      refs.push({
        sourceId: `rss_${Buffer.from(item.link).toString("base64url").slice(0, 32)}`,
        platform: "rss",
        sourceAdapter: this.id,
        canonicalUrl: item.link,
        discoveredAt,
        metadata: { feedUrl: feed.url, feedTitle: parsed.feedTitle, title: item.title, published: item.published },
      });
    }
    return refs;
  }

  async fetch(reference: SourceReference): Promise<RawArtifact> {
    const url = reference.canonicalUrl || "";
    if (!url) throw new Error("Feed adapter requires an article URL.");
    const page = await fetchPublicText(url);
    const cleaned = quarantineExternalText(page.text);
    return {
      id: reference.sourceId,
      reference,
      type: "html",
      mimeType: "text/html",
      textPayload: cleaned.text,
      jsonPayload: { finalUrl: page.url, extractor: page.extractor },
      capturedAt: new Date().toISOString(),
    };
  }
}
