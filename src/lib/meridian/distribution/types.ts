/** Standardized Multi-Channel Distribution Types (Organic Social + Paid Advertising). */

export type DistributionTargetType = "paid_ad" | "organic_post";

export type PlatformId = "instagram" | "facebook" | "youtube" | "tiktok";

export type AspectRatio = "9:16" | "1:1" | "16:9" | "4:5";

export type OrganicPublishRequest = {
  brandId: string;
  organizationId: string;
  creativeId?: string;
  assetId?: string;
  mediaBytes: Uint8Array;
  mimeType: string;
  caption: string;
  title?: string;
  tags?: string[];
  scheduledFor?: string;
  aspectRatio: AspectRatio;
  metadata?: Record<string, unknown>;
  allowTestProvider?: boolean;
};

export type OrganicPublishReceipt = {
  externalId: string;
  postUrl?: string;
  platform: PlatformId;
  status: "published" | "scheduled" | "failed";
  publishedAt?: string;
  error?: string;
};

export type OrganicTelemetryMetrics = {
  views: number;
  reach: number;
  threeSecondViews?: number;
  averageWatchTimeSeconds?: number;
  completionRate?: number;
  likes: number;
  comments: number;
  shares: number;
  saves?: number;
};

export interface DistributionChannel {
  readonly id: string;
  readonly platform: PlatformId;
  readonly targetType: DistributionTargetType;
  readonly displayName: string;

  checkConnection(brandId: string): Promise<{ connected: boolean; accountName?: string; reason?: string }>;
  publish(request: OrganicPublishRequest): Promise<OrganicPublishReceipt>;
  /** Null when the metrics are not observed. A channel never returns invented numbers. */
  fetchMetrics(externalId: string): Promise<OrganicTelemetryMetrics | null>;
}
