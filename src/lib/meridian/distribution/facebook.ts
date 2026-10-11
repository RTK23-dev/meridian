import { createHash } from "node:crypto";
import type { DistributionChannel, OrganicPublishRequest, OrganicPublishReceipt, OrganicTelemetryMetrics } from "./types.ts";
import { isTestingRuntimeNow } from "../runtime-mode.ts";

export class FacebookPagesChannel implements DistributionChannel {
  public readonly id = "facebook-pages";
  public readonly platform = "facebook" as const;
  public readonly targetType = "organic_post" as const;
  public readonly displayName = "Facebook Page Video & Reels";

  /**
   * No per-workspace Facebook account is connected in this release, and no token from the environment is treated as a connected
   * account. Live posting is not available, so the honest state is not connected, with the manual export as the way out.
   */
  async checkConnection(brandId: string): Promise<{ connected: boolean; accountName?: string; reason?: string }> {
    void brandId;
    return {
      connected: false,
      reason: "Live Facebook posting is not available in this release. Export the package and post it manually.",
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

    return {
      externalId: "",
      platform: "facebook",
      status: "failed",
      error: connection.reason || "Facebook is not connected. Nothing was published.",
    };
  }

  async fetchMetrics(externalId: string): Promise<OrganicTelemetryMetrics | null> {
    // Live metrics are not implemented in this build. Nothing is observed, so nothing is returned: no fixed
    // numbers stand in for engagement.
    void externalId;
    return null;
  }
}
