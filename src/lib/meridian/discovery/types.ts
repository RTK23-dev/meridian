/**
 * Research Frontier & Organic Discovery Stack Contracts and Types
 */

export type DiscoverySourceTier = "graph_api" | "vendor" | "cyclone_scout" | "bulk_upload";

export interface DiscoveredAudioTrend {
  id: string;
  name: string;
  isTrending: boolean;
  reelCount?: number;
  originalCreatorHandle?: string;
  firstSeenAt: string;
}

export interface DiscoveredReelItem {
  id: string;
  permalink?: string;
  externalPostId?: string;
  creatorHandle: string;
  creatorFollowerCount?: number;
  creatorLast30MedianViews?: number;
  creatorVariance?: number;
  niche: string;
  caption: string;
  hashtags: string[];
  audio: DiscoveredAudioTrend;
  durationMs?: number;
  postedAt?: string;
  discoveredAt: string;
  discoveryTier: DiscoverySourceTier;
  scoutDeviceId?: string;
  scoutSessionId?: string;
  scoutObservationTime?: string;
  screenshotArtifactId?: string;
  screenshotUrl?: string;
  metrics: {
    views?: number;
    likes?: number;
    comments?: number;
    shares?: number;
    saves?: number;
  };
}

export interface PostSnapshot {
  postId: string;
  hoursSincePost: number;
  views: number;
  likes: number;
  comments: number;
  shares?: number;
  saves?: number;
  friendTagComments: number;
  capturedAt: string;
}

export interface VelocityAnalysis {
  hoursElapsed: number;
  viewsGainPerHour: number;
  accelerationScore: number; // derivative of views slope
  isExploding: boolean;
}

export type DiscoveryScope =
  | "scrape_page"
  | "page_plus_links"
  | "domain"
  | "niche"
  | "profile"
  | "url_list";

export type DiscoveryRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "blocked"
  | "failed";

export interface CrawlBudget {
  maxPages: number;
  maxDepth: number;
  maxBytes?: number;
  concurrency: number;
  delayMs?: number;
  allowedHosts?: string[];
}

export interface DiscoveredItem {
  id: string;
  runId: string;
  url: string;
  canonicalUrl: string;
  source: string;
  cardType: "article" | "post" | "ad_card" | "video" | "product";
  title?: string;
  text?: string;
  mediaUrl?: string;
  destinationUrl?: string;
  creator?: string;
  publishedAt?: string;
  metrics: Record<string, { value: number | null; state: "OBSERVED" | "COMPUTED" | "INFERRED" | "UNAVAILABLE" }>;
  contentHash: string;
  sourceLocation: string;
  discoveredAt: string;
}

/**
 * What one source did for one seed in one run. `ran` means the source was called and its results were processed (zero
 * results is still `ran`). The other states say why nothing was read, so a gated source is never shown as connected.
 */
export type SourceRunState =
  | {
      adapterId: string;
      seed: string;
      status: "ran";
      /** Items stored by this run from this source. */
      itemsFound: number;
      /** Items that matched a record already stored for this brand, so they were not stored again. */
      seenBefore: number;
      /** The adapter's health status when this run fetched from it. */
      sourceStatus: string;
    }
  | {
      adapterId: string;
      seed: string;
      status: "not_configured" | "not_supported";
      /** The resolver's reason, or the adapter's own explanation. Shown to the user. */
      reason: string;
    }
  | {
      adapterId: string;
      seed: string;
      status: "failed";
      /** The error the call raised. */
      reason: string;
    };

export interface DiscoveryRun {
  id: string;
  organizationId: string;
  brandId: string;
  scope: DiscoveryScope;
  seeds: string[];
  budget: CrawlBudget;
  status: DiscoveryRunStatus;
  progress: {
    pagesCrawled: number;
    discoveredCards: number;
    discoveredUrls: number;
    /** Records this run matched to ones already stored for the brand. They are counted here, not stored again. */
    seenBefore?: number;
    /** One entry per source and seed. Stored with the run, so a resumed run keeps the states it already recorded. */
    sources?: SourceRunState[];
  };
  perSourceErrors: Record<string, string>;
  caveat?: string;
  cursorState?: Record<string, unknown>;
  startedAt: string;
  completedAt?: string;
}
