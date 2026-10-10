import { createHash } from "node:crypto";
import type { DistributionChannel, OrganicPublishRequest, OrganicPublishReceipt, OrganicTelemetryMetrics } from "./types.ts";
import { isTestingRuntimeNow } from "../runtime-mode.ts";

export class YouTubeShortsChannel implements DistributionChannel {
  public readonly id = "youtube-shorts";
  public readonly platform = "youtube" as const;
  public readonly targetType = "organic_post" as const;
  public readonly displayName = "YouTube Shorts & Video";

  async checkConnection(brandId: string): Promise<{ connected: boolean; accountName?: string; reason?: string }> {
    const apiKey = process.env.YOUTUBE_API_KEY || process.env.GOOGLE_API_KEY;
    const channelId = process.env.YOUTUBE_CHANNEL_ID;
    if (!apiKey || !channelId) {
      return {
        connected: false,
        reason: "Missing YOUTUBE_API_KEY or YOUTUBE_CHANNEL_ID in environment.",
      };
    }
    return {
      connected: true,
      accountName: `YouTube Channel ${brandId.slice(0, 8)}`,
    };
  }

  async publish(request: OrganicPublishRequest): Promise<OrganicPublishReceipt> {
    if (!request.mediaBytes || request.mediaBytes.byteLength === 0) {
      return {
        externalId: "",
        platform: "youtube",
        status: "failed",
        error: "Media bytes cannot be empty.",
      };
    }

    if (!request.mimeType.startsWith("video/")) {
      return {
        externalId: "",
        platform: "youtube",
        status: "failed",
        error: `YouTube accepts video files only (received ${request.mimeType}).`,
      };
    }

    const sha256 = createHash("sha256").update(request.mediaBytes).digest("hex");
    const connection = await this.checkConnection(request.brandId);

    if (!connection.connected && request.allowTestProvider && isTestingRuntimeNow()) {
      const mockExternalId = `yt_test_${sha256.slice(0, 11)}`;
      return {
        externalId: mockExternalId,
        postUrl: `https://www.youtube.com/shorts/${mockExternalId}`,
        platform: "youtube",
        status: "published",
        publishedAt: new Date().toISOString(),
      };
    }

    if (!connection.connected) {
      return {
        externalId: "",
        platform: "youtube",
        status: "failed",
        error: connection.reason || "YouTube Channel is not connected.",
      };
    }

    try {
      // Live YouTube publishing is not implemented in this build. Nothing is reported as published.
      return {
        externalId: "",
        platform: "youtube",
        status: "failed",
        error: "Live YouTube publishing is not implemented in this build. Nothing was published.",
      };
    } catch (caught) {
      return {
        externalId: "",
        platform: "youtube",
        status: "failed",
        error: caught instanceof Error ? caught.message : String(caught),
      };
    }
  }

  async fetchMetrics(externalId: string): Promise<OrganicTelemetryMetrics | null> {
    // Live metrics are not implemented in this build. Nothing is observed, so nothing is returned: no fixed
    // numbers stand in for engagement.
    void externalId;
    return null;
  }
}
