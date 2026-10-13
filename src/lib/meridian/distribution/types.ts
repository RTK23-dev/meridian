/** Standardized Multi-Channel Distribution Types (Organic Social + Paid Advertising). */

export type DistributionTargetType = "paid_ad" | "organic_post";

export type PlatformId = "instagram" | "facebook" | "youtube" | "tiktok";

export type AspectRatio = "9:16" | "1:1" | "16:9" | "4:5";

/** The organic platforms that have a connected-account publisher. */
export type OrganicPlatform = "instagram" | "facebook" | "youtube" | "tiktok";

/**
 * A workspace's connected organic account, resolved from `platform_accounts` and its encrypted `credential_vault` token by
 * `resolveOrganicConnection`. The token is passed only to the channel that makes the request. It is never returned to a
 * client, logged, or written to a receipt.
 */
export type OrganicConnection =
  | {
      connected: true;
      platform: OrganicPlatform;
      accountId: string;
      accountName: string;
      accessToken: string;
      /** The scopes the stored token declares, or null when the token does not say. */
      scopes: string[] | null;
    }
  | { connected: false; platform: OrganicPlatform; reason: string };

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
  /** Resolved by the service before the call. A channel never reads the database or the environment for a token. */
  connection?: OrganicConnection;
  /**
   * A signed, short-lived https link to the approved file (storage/media-link.ts). Set by the service for a channel that publishes
   * by URL, Instagram and TikTok. The platform fetches it, so the channel sends it and never the bytes.
   */
  mediaUrl?: string;
  /** The hostnames TikTok has verified for this app, from TIKTOK_VERIFIED_MEDIA_DOMAINS. A TikTok channel refuses a URL outside them. */
  verifiedMediaDomains?: string[];
};

/**
 * Why a receipt is not a publish. `NOT_CONNECTED` means nothing was attempted. `AUTH_FAILED` means the stored token was refused.
 * `RETRYABLE` means the provider rate-limited the request before it was processed. `UNCONFIRMED` means the provider did not
 * confirm the publish, so it is not reported as published and must be checked by hand. `REJECTED` means the provider refused
 * the content or the request.
 */
export type ReceiptCode = "NOT_CONNECTED" | "AUTH_FAILED" | "RETRYABLE" | "UNCONFIRMED" | "REJECTED";

export type OrganicPublishReceipt = {
  externalId: string;
  postUrl?: string;
  platform: PlatformId;
  status: "published" | "scheduled" | "failed";
  publishedAt?: string;
  error?: string;
  code?: ReceiptCode;
};

export type ConnectionCheck = { connected: boolean; accountName?: string; reason?: string; code?: ReceiptCode };

/**
 * The metrics a platform reported for one post. A metric the platform did not report is null, never zero. The channels that
 * have no live metric client return null for the whole object, so nothing is stored for them.
 */
export type OrganicTelemetryMetrics = {
  views: number | null;
  reach: number | null;
  threeSecondViews: number | null;
  averageWatchTimeSeconds: number | null;
  completionRate: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
};

export interface DistributionChannel {
  readonly id: string;
  readonly platform: PlatformId;
  readonly targetType: DistributionTargetType;
  readonly displayName: string;

  /** Pure: reports the state of the connection the service resolved. It never reads the environment. */
  checkConnection(connection: OrganicConnection | undefined): ConnectionCheck;
  publish(request: OrganicPublishRequest): Promise<OrganicPublishReceipt>;
  /** Null when the metrics are not observed. A channel never returns invented numbers. */
  fetchMetrics(externalId: string): Promise<OrganicTelemetryMetrics | null>;
}
