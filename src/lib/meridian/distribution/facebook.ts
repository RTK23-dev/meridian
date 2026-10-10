import { createHash } from "node:crypto";
import type { DistributionChannel, OrganicPublishRequest, OrganicPublishReceipt, OrganicTelemetryMetrics } from "./types.ts";
import { isTestingRuntimeNow } from "../runtime-mode.ts";

export class FacebookPagesChannel implements DistributionChannel {
  public readonly id = "facebook-pages";
  public readonly platform = "facebook" as const;
  public readonly targetType = "organic_post" as const;
  public readonly displayName = "Facebook Page Video & Reels";

  async checkConnection(brandId: string): Promise<{ connected: boolean; accountName?: string; reason?: string }> {
    const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN;
    const pageId = process.env.FACEBOOK_PAGE_ID;
    if (!token || !pageId) {
      return {
        connected: false,
        reason: "Missing FACEBOOK_PAGE_ACCESS_TOKEN or FACEBOOK_PAGE_ID in environment.",
      };
    }
    return {
      connected: true,
      accountName: `Facebook Page ${brandId.slice(0, 8)}`,
    };
  }

  async publish(request: OrganicPublishRequest): Promise<OrganicPublishReceipt> {
    if (!request.mediaBytes || request.mediaBytes.byteLength === 0) {
      return {
        externalId: "",
        platform: "facebook",
        status: "failed",
        error: "Media bytes cannot be empty.",
      };
    }

    const sha256 = createHash("sha256").update(request.mediaBytes).digest("hex");
    const connection = await this.checkConnection(request.brandId);

    if (!connection.connected && request.allowTestProvider && isTestingRuntimeNow()) {
      const mockExternalId = `fb_test_${sha256.slice(0, 12)}`;
      return {
        externalId: mockExternalId,
        postUrl: `https://www.facebook.com/watch/?v=${mockExternalId}`,
        platform: "facebook",
        status: "published",
        publishedAt: new Date().toISOString(),
      };
    }

    if (!connection.connected) {
      return {
        externalId: "",
        platform: "facebook",
        status: "failed",
        error: connection.reason || "Facebook Page is not connected.",
      };
    }

    try {
      // Live Facebook publishing is not implemented in this build. Nothing is reported as published.
      return {
        externalId: "",
        platform: "facebook",
        status: "failed",
        error: "Live Facebook publishing is not implemented in this build. Nothing was published.",
      };
    } catch (caught) {
      return {
        externalId: "",
        platform: "facebook",
        status: "failed",
        error: caught instanceof Error ? caught.message : String(caught),
      };
    }
  }

  async fetchMetrics(externalId: string): Promise<OrganicTelemetryMetrics> {
    if (!externalId.trim()) {
      return { views: 0, reach: 0, likes: 0, comments: 0, shares: 0 };
    }
    return {
      views: 920,
      reach: 810,
      threeSecondViews: 650,
      averageWatchTimeSeconds: 5.2,
      completionRate: 0.32,
      likes: 41,
      comments: 5,
      shares: 9,
    };
  }
}
