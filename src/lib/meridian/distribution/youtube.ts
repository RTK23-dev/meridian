import { createHash } from "node:crypto";
import type { DistributionChannel, OrganicPublishRequest, OrganicPublishReceipt, OrganicTelemetryMetrics } from "./types.ts";
import { isTestingRuntimeNow } from "../runtime-mode.ts";

export class YouTubeShortsChannel implements DistributionChannel {
  public readonly id = "youtube-shorts";
  public readonly platform = "youtube" as const;
  public readonly targetType = "organic_post" as const;
  public readonly displayName = "YouTube Shorts & Video";

  /**
   * No per-workspace YouTube account is connected in this release, and no token from the environment is treated as a connected
   * account. Live posting is not available, so the honest state is not connected, with the manual export as the way out.
   */
  async checkConnection(brandId: string): Promise<{ connected: boolean; accountName?: string; reason?: string }> {
    void brandId;
    return {
      connected: false,
      reason: "Live YouTube posting is not available in this release. Export the package and post it manually.",
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

    return {
      externalId: "",
      platform: "youtube",
      status: "failed",
      error: connection.reason || "YouTube is not connected. Nothing was published.",
    };
  }

  async fetchMetrics(externalId: string): Promise<OrganicTelemetryMetrics | null> {
    // Live metrics are not implemented in this build. Nothing is observed, so nothing is returned: no fixed
    // numbers stand in for engagement.
    void externalId;
    return null;
  }
}
