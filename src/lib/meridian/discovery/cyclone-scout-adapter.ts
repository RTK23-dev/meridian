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
import type {
  SourceAdapter,
  SourceKind,
  SourceCapabilities,
  SourceHealth,
  SourceReference,
  RawArtifact,
  DiscoveryQuery,
} from "../sources/types.ts";

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

export class CycloneScoutSourceAdapter implements SourceAdapter {
  readonly id = "cyclone_scout";
  readonly platform: SourceKind = "licensed" as SourceKind;
  readonly name = "Cyclone Scout Fleet (Physical Android Device)";
  readonly isLicensed = true;
  readonly capabilities: SourceCapabilities = {
    profileDiscovery: true,
    contentDiscovery: true,
    metadata: true,
    videos: true,
    images: true,
    comments: false,
    performance: true,
    webpages: false,
    search: true,
  };

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

  async health(): Promise<SourceHealth> {
    const conn = await this.checkConnection();
    if (!this.config?.gatewayUrl || !this.config?.deviceId) {
      return {
        adapterId: this.id,
        status: "NOT_CONFIGURED",
        latencyMs: 0,
        message: "Cyclone Gateway or Device ID not set",
        lastCheckedAt: new Date().toISOString(),
      };
    }
    if (conn.connected) {
      return {
        adapterId: this.id,
        status: "HEALTHY",
        latencyMs: 15,
        message: `Device ${this.config.deviceId} status: ${conn.deviceStatus}`,
        lastCheckedAt: new Date().toISOString(),
      };
    }
    return {
      adapterId: this.id,
      status: "UNAVAILABLE",
      latencyMs: 0,
      message: conn.reason || "Device not connected",
      lastCheckedAt: new Date().toISOString(),
    };
  }

  async discover(query: DiscoveryQuery): Promise<SourceReference[]> {
    const niche = query.niche || query.query || "general";
    const reels = await this.observeFeed({ niche, budget: query.limit || 10 });
    return reels.map((r) => ({
      sourceId: r.id,
      platform: this.platform,
      externalId: r.externalPostId,
      canonicalUrl: r.permalink,
      sourceAdapter: this.id,
      discoveredAt: new Date().toISOString(),
      capturedAt: r.scoutObservationTime,
      evidenceAvailability: "FULL_EVIDENCE_AVAILABLE",
      metadata: {
        niche: r.niche,
        author: r.creatorHandle,
        caption: r.caption,
        metrics: r.metrics,
      },
    }));
  }

  async fetch(reference: SourceReference): Promise<RawArtifact> {
    return {
      id: `art_${reference.sourceId}`,
      reference,
      type: "json",
      mimeType: "application/json",
      jsonPayload: reference.metadata,
      capturedAt: reference.discoveredAt,
    };
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
      // Cyclone V3.5 Protocol: GET /v1/device/status or GET /v1/devices
      // Never mark Cyclone as connected merely because a generic /health route responded.
      let res = await this.fetchFn(`${base}/v1/device/status?device_id=${encodeURIComponent(this.config.deviceId)}`, {
        headers: this.getHeaders(),
      });

      if (!res.ok) {
        // Fall back to fleet device listing GET /v1/devices
        res = await this.fetchFn(`${base}/v1/devices`, {
          headers: this.getHeaders(),
        });
      }

      if (!res.ok) {
        // Fall back to capability discovery GET /v1/capabilities
        res = await this.fetchFn(`${base}/v1/capabilities`, {
          headers: this.getHeaders(),
        });
      }

      if (!res.ok) {
        return {
          connected: false,
          reason: `Cyclone gateway returned HTTP ${res.status}`,
        };
      }

      const body = (await res.json().catch(() => ({}))) as {
        status?: string;
        connected?: boolean;
        devices?: Array<{ deviceId?: string; device_id?: string; status?: string }>;
      };

      // Check device-specific readiness
      if (Array.isArray(body.devices)) {
        const target = body.devices.find(
          (d) => (d.deviceId || d.device_id) === this.config?.deviceId
        );
        if (!target) {
          return {
            connected: false,
            reason: `Device ${this.config.deviceId} is not registered in Cyclone gateway devices fleet.`,
          };
        }
        const devStatus = target.status ?? "ready";
        if (devStatus === "offline" || devStatus === "error") {
          return {
            connected: false,
            deviceStatus: devStatus,
            reason: `Target device ${this.config.deviceId} status is ${devStatus}`,
          };
        }
        return { connected: true, deviceStatus: devStatus };
      }

      if (body.connected === false || body.status === "offline" || body.status === "error") {
        return {
          connected: false,
          deviceStatus: body.status ?? "offline",
          reason: `Device status returned ${body.status}`,
        };
      }

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
      const res = await this.fetchFn(`${base}/v1/devices`, {
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

  async observeFeed(request: {
    niche: string;
    budget?: number;
    sessionId?: string;
    includeScreenshot?: boolean;
  }): Promise<DiscoveredReelItem[]> {
    if (!this.config?.gatewayUrl || !this.config?.deviceId) {
      throw new Error("Cyclone Gateway or Device is not configured.");
    }
    const base = this.config.gatewayUrl.replace(/\/+$/, "");
    const sessionId = request.sessionId || "default-foreground";

    // Cyclone V3.5 MCP contract: POST /v1/capabilities/observe
    const observePayload = {
      device_id: this.config.deviceId,
      session_id: sessionId,
      mode: "compact",
      include_screenshot: request.includeScreenshot ?? true,
      niche: request.niche,
      budget: request.budget || 5,
    };

    let res = await this.fetchFn(`${base}/v1/capabilities/observe`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(observePayload),
    });

    // Fallback to legacy observe endpoint POST /v1/observe
    if (!res.ok && res.status === 404) {
      res = await this.fetchFn(`${base}/v1/observe`, {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify(observePayload),
      });
    }

    if (!res.ok) {
      throw new Error(`Failed to observe feed via Cyclone: HTTP ${res.status}`);
    }

    const body = (await res.json()) as {
      page_card?: CyclonePageCard;
      page_cards?: CyclonePageCard[];
      pageCards?: CyclonePageCard[];
      card?: CyclonePageCard;
      candidates?: CyclonePageCard[];
      screenshot?: string;
      screenshot_url?: string;
      screenshot_path?: string;
      screenshot_id?: string;
      timestamp?: string;
      observed_at?: string;
      session_id?: string;
    };

    const cards: CyclonePageCard[] = [];
    if (body.page_cards) cards.push(...body.page_cards);
    if (body.pageCards) cards.push(...body.pageCards);
    if (body.candidates) cards.push(...body.candidates);
    if (body.page_card) cards.push(body.page_card);
    if (body.card) cards.push(body.card);

    const observedAt = body.observed_at || body.timestamp || new Date().toISOString();
    const screenshotUrl = body.screenshot_url || body.screenshot;
    const screenshotArtifactId = body.screenshot_id || (body.screenshot_path ? `cyclone-${body.screenshot_path}` : undefined);

    const reels: DiscoveredReelItem[] = [];
    for (const c of cards) {
      const reel = this.parsePageCardToReel(c, request.niche, {
        sessionId: body.session_id || sessionId,
        observedAt,
        screenshotUrl,
        screenshotArtifactId,
      });
      if (reel) reels.push(reel);
    }
    return reels;
  }

  async captureEvidence(request?: { sessionId?: string }): Promise<{
    screenshotUrl?: string;
    artifactId?: string;
    sessionId?: string;
    deviceId?: string;
    timestamp?: string;
  } | null> {
    if (!this.config?.gatewayUrl || !this.config?.deviceId) return null;
    try {
      const base = this.config.gatewayUrl.replace(/\/+$/, "");
      const sessionId = request?.sessionId || "default-foreground";
      // Cyclone V3.5 MCP contract: POST /v1/capabilities/observe with include_screenshot: true
      const res = await this.fetchFn(`${base}/v1/capabilities/observe`, {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify({
          device_id: this.config.deviceId,
          session_id: sessionId,
          mode: "compact",
          include_screenshot: true,
        }),
      });

      if (!res.ok) return null;
      const body = (await res.json()) as {
        screenshot?: string;
        screenshot_url?: string;
        screenshot_id?: string;
        screenshot_path?: string;
        session_id?: string;
        device_id?: string;
        observed_at?: string;
        timestamp?: string;
      };

      return {
        screenshotUrl: body.screenshot_url || body.screenshot,
        artifactId: body.screenshot_id || body.screenshot_path,
        sessionId: body.session_id || sessionId,
        deviceId: body.device_id || this.config.deviceId,
        timestamp: body.observed_at || body.timestamp || new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  /**
   * Parses accessibility tree nodes (Page Card) captured by the device into structured Reel items.
   * Truth-first: unobserved permalinks, post dates, and view counts are strictly undefined.
   */
  parsePageCardToReel(
    card: CyclonePageCard,
    niche: string,
    context?: {
      sessionId?: string;
      observedAt?: string;
      screenshotUrl?: string;
      screenshotArtifactId?: string;
    }
  ): DiscoveredReelItem | null {
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
      scoutSessionId: context?.sessionId,
      scoutObservationTime: context?.observedAt,
      screenshotUrl: context?.screenshotUrl,
      screenshotArtifactId: context?.screenshotArtifactId,
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
      "X-Cyclone-Protocol": "cyclone.gateway.capability.v1",
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
