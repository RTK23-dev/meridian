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
  };
  perSourceErrors: Record<string, string>;
  caveat?: string;
  cursorState?: Record<string, unknown>;
  startedAt: string;
  completedAt?: string;
}
