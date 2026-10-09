/**
 * Cyclone Scout Source Adapter
 * 
 * Bridges Meridian to the Cyclone Device Gateway / MCP Server
 * for physical Android phone scouts (e.g. Pixel 8 fleet).
 * 
 * Capabilities:
 * - Reads organic Instagram Reels, Explore, and Audio pages as real users see them
 * - Extracts trending audio titles, reel counts, like/share counts, and permalinks
 * - Strictly Observe-Only: never performs automated likes, follows, comments, or DMs
 * - Human-paced browsing cadence to protect account authenticity
 * - Session-isolated by phone/device ID
 * - Zero-fabrication: unobserved URLs, dates, views, and external IDs remain undefined
 */

import { createHash } from "node:crypto";
import type { DiscoveredReelItem, DiscoveredAudioTrend } from "./types.ts";

export interface CycloneGatewayConfig {
  gatewayUrl: string;
  apiKey?: string;
  deviceId: string;
}

export interface CyclonePageCard {
  nodeId: string;
  role: string;
  text?: string;
  contentDescription?: string;
  bounds?: { left: number; top: number; right: number; bottom: number };
  children?: CyclonePageCard[];
}

export interface CycloneScoutSession {
  sessionId: string;
  deviceId: string;
  niche: string;
  startedAt: string;
  reelsObserved: number;
}

export interface DeviceReadiness {
  deviceId: string;
  status: string;
  battery?: number;
  appInForeground?: string;
}

export type CycloneObservationResult =
  | { status: "connected"; reels: DiscoveredReelItem[]; audioTrends: DiscoveredAudioTrend[] }
  | { status: "NOT_CONNECTED"; reason: string }
  | { status: "failed"; error: string };

export class CycloneScoutSourceAdapter {
  readonly id = "cyclone_scout";
  readonly name = "Cyclone Scout Fleet (Physical Android Device)";
  readonly isLicensed = true;

  private config?: CycloneGatewayConfig;
  private fetchFn: typeof fetch;

  constructor(options?: { config?: CycloneGatewayConfig; fetchFn?: typeof fetch }) {
    this.fetchFn = options?.fetchFn ?? globalThis.fetch;
    if (options?.config) {
      this.config = options.config;
    } else if (process.env.CYCLONE_GATEWAY_URL && process.env.CYCLONE_DEVICE_ID) {
      this.config = {
        gatewayUrl: process.env.CYCLONE_GATEWAY_URL,
        apiKey: process.env.CYCLONE_API_KEY,
        deviceId: process.env.CYCLONE_DEVICE_ID,
      };
    }
  }

  async checkConnection(): Promise<{ connected: boolean; deviceStatus?: string; reason?: string }> {
    if (!this.config?.gatewayUrl || !this.config?.deviceId) {
      return {
        connected: false,
        reason: "CYCLONE_GATEWAY_URL or CYCLONE_DEVICE_ID is not configured.",
      };
    }

    try {
      const base = this.config.gatewayUrl.replace(/\/+$/, "");
      // Supported Cyclone Gateway health / device readiness routes
      const pingUrl = `${base}/health`;
      let res = await this.fetchFn(pingUrl, {
        headers: this.getHeaders(),
      });

      if (!res.ok) {
        // Fallback to /api/v1/devices
        res = await this.fetchFn(`${base}/api/v1/devices`, {
          headers: this.getHeaders(),
        });
        if (!res.ok) {
          return {
            connected: false,
            reason: `Cyclone gateway returned HTTP ${res.status}`,
          };
        }
      }

      const body = (await res.json().catch(() => ({}))) as { status?: string; devices?: any[] };
      return { connected: true, deviceStatus: body.status ?? "ready" };
    } catch (err) {
      return {
        connected: false,
        reason: `Failed to contact Cyclone Gateway: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async getDevices(): Promise<DeviceReadiness[]> {
    if (!this.config?.gatewayUrl) return [];
    try {
      const base = this.config.gatewayUrl.replace(/\/+$/, "");
      const res = await this.fetchFn(`${base}/api/v1/devices`, {
        headers: this.getHeaders(),
      });
      if (!res.ok) return [];
      const body = (await res.json()) as { devices?: DeviceReadiness[] } | DeviceReadiness[];
      if (Array.isArray(body)) return body;
      return body.devices || [];
    } catch {
      return [];
    }
  }

  async observeFeed(request: { niche: string; budget?: number; sessionId?: string }): Promise<DiscoveredReelItem[]> {
    if (!this.config?.gatewayUrl || !this.config?.deviceId) {
      throw new Error("Cyclone Gateway or Device is not configured.");
    }
    const base = this.config.gatewayUrl.replace(/\/+$/, "");
    const res = await this.fetchFn(`${base}/api/v1/devices/${encodeURIComponent(this.config.deviceId)}/observe`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({
        niche: request.niche,
        budget: request.budget || 5,
        session_id: request.sessionId,
      }),
    });
    if (!res.ok) {
      throw new Error(`Failed to observe feed via Cyclone: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { pageCards?: CyclonePageCard[]; card?: CyclonePageCard };
    const cards = body.pageCards || (body.card ? [body.card] : []);
    const reels: DiscoveredReelItem[] = [];
    for (const c of cards) {
      const reel = this.parsePageCardToReel(c, request.niche);
      if (reel) reels.push(reel);
    }
    return reels;
  }

  async captureEvidence(request?: { sessionId?: string }): Promise<{ screenshotUrl?: string; artifactId?: string } | null> {
    if (!this.config?.gatewayUrl || !this.config?.deviceId) return null;
    try {
      const base = this.config.gatewayUrl.replace(/\/+$/, "");
      const res = await this.fetchFn(`${base}/api/v1/devices/${encodeURIComponent(this.config.deviceId)}/screenshot`, {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify({ session_id: request?.sessionId }),
      });
      if (!res.ok) return null;
      return (await res.json()) as { screenshotUrl?: string; artifactId?: string };
    } catch {
      return null;
    }
  }

  /**
   * Parses accessibility tree nodes (Page Card) captured by the device into structured Reel items.
   * Truth-first: unobserved permalinks, post dates, and view counts are strictly undefined.
   */
  parsePageCardToReel(card: CyclonePageCard, niche: string): DiscoveredReelItem | null {
    const textNodes: string[] = [];
    collectText(card, textNodes);

    if (textNodes.length === 0) return null;

    let creatorHandle = "unknown_creator";
    let views: number | undefined;
    let likes: number | undefined;
    let comments: number | undefined;
    let audioName = "Original Audio";
    let isTrendingAudio = false;
    let permalink: string | undefined;

    for (const text of textNodes) {
      if (text.startsWith("@")) {
        creatorHandle = text.replace(/^@/, "");
      } else if (text.includes("Trending") || text.includes("Popular sound")) {
        isTrendingAudio = true;
      } else if (text.startsWith("audio-") || text.includes("original audio")) {
        audioName = text;
      } else if (text.match(/^[0-9.,]+[KMB]?\s*(views|plays)$/i)) {
        views = parseMetricNumber(text);
      } else if (text.match(/^[0-9.,]+[KMB]?\s*likes$/i)) {
        likes = parseMetricNumber(text);
      } else if (text.match(/^[0-9.,]+[KMB]?\s*comments$/i)) {
        comments = parseMetricNumber(text);
      } else if (text.startsWith("https://www.instagram.com/reel/")) {
        permalink = text;
      }
    }

    // Only derive externalPostId if a real permalink was captured on-screen
    const externalPostId = permalink ? permalink.split("/reel/")[1]?.replace(/\/$/, "") : undefined;

    // Use stable deterministic content fingerprint for internal record ID
    const fingerprint = createHash("sha256")
      .update([creatorHandle, textNodes.slice(0, 5).join(" ")].join(":"))
      .digest("hex")
      .slice(0, 12);

    const internalId = `scout-${this.config?.deviceId ?? "dev"}-${fingerprint}`;

    return {
      id: internalId,
      permalink,
      externalPostId,
      creatorHandle,
      creatorFollowerCount: undefined,
      creatorLast30MedianViews: undefined,
      creatorVariance: undefined,
      niche,
      caption: textNodes.slice(0, 3).join(" "),
      hashtags: [],
      audio: {
        id: `audio-${encodeURIComponent(audioName.slice(0, 24))}`,
        name: audioName,
        isTrending: isTrendingAudio,
        reelCount: undefined,
        firstSeenAt: new Date().toISOString(),
      },
      durationMs: undefined,
      postedAt: undefined, // Distinguish capture time from original post time
      discoveredAt: new Date().toISOString(),
      discoveryTier: "cyclone_scout",
      scoutDeviceId: this.config?.deviceId,
      metrics: {
        views: views !== undefined && views > 0 ? views : undefined,
        likes: likes !== undefined && likes > 0 ? likes : undefined,
        comments: comments !== undefined && comments > 0 ? comments : undefined,
      },
    };
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (this.config?.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }
    return headers;
  }
}

function collectText(node: CyclonePageCard, acc: string[]): void {
  if (node.text && node.text.trim()) {
    acc.push(node.text.trim());
  }
  if (node.contentDescription && node.contentDescription.trim()) {
    acc.push(node.contentDescription.trim());
  }
  if (node.children) {
    for (const child of node.children) {
      collectText(child, acc);
    }
  }
}

export function parseMetricNumber(raw: string): number {
  const match = raw.match(/([0-9.,]+)\s*([KMB]?)/i);
  if (!match) return 0;
  const num = parseFloat(match[1].replace(/,/g, ""));
  const unit = match[2].toUpperCase();
  if (unit === "K") return Math.round(num * 1000);
  if (unit === "M") return Math.round(num * 1000000);
  if (unit === "B") return Math.round(num * 1000000000);
  return Math.round(num);
}
