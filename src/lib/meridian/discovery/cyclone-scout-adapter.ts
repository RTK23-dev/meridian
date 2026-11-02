/**
 * Cyclone Scout Source Adapter
 *
 * Bridges Meridian to the Cyclone Device Gateway for an Android phone that scouts Instagram as a real user would (for example, a Pixel 8
 * fleet device). The gateway and the device are set by the deployment's environment (CYCLONE_GATEWAY_URL, CYCLONE_DEVICE_ID, CYCLONE_API_KEY),
 * by design: docs/PROVIDERS.md.
 *
 * Capabilities:
 * - Reads organic Instagram Reels, Explore and Audio pages as a person sees them, and keeps the screenshot the device took.
 * - Strictly observe-only: no likes, follows, comments or DMs. Browsing is paced by the device.
 * - Session provenance: each observation carries the device and session that made it.
 * - Zero fabrication: a permalink, a post date, a view count or an observation time that was not on screen or sent by the gateway stays undefined.
 * - Untrusted output: everything the gateway sends is read as data. A screenshot address must be a web address.
 */

import { createHash } from "node:crypto";
import { cycloneApiKey } from "../credentials/secret-settings.ts";
import { cycloneDeviceIdSetting, cycloneGatewayUrlSetting } from "../config/server-settings.ts";
import type { DiscoveredAudioTrend, DiscoveredReelItem } from "./types.ts";
import type {
  DiscoveryQuery,
  EvidenceAvailability,
  RawArtifact,
  SourceAdapter,
  SourceCapabilities,
  SourceHealth,
  SourceKind,
  SourceReference,
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

export type CycloneConnectionCheck = { connected: boolean; deviceStatus?: string; reason?: string };

/** How long a gateway may take to answer one request. A device that does not answer in time is treated as not connected. */
export const CYCLONE_REQUEST_TIMEOUT_MS = 15_000;

/** The longest address the adapter keeps for a screenshot. Longer values are not stored. */
const MAX_URL_CHARS = 2048;

export class CycloneScoutSourceAdapter implements SourceAdapter {
  readonly id = "cyclone_scout";
  readonly platform: SourceKind = "cyclone_scout";
  readonly name = "Cyclone Scout Fleet (Physical Android Device)";
  // What the adapter does: it reads the feed (text and metrics on screen) and keeps a screenshot. It does not read video files, search
  // the platform, or read profiles, so those are false.
  readonly capabilities: SourceCapabilities = {
    profileDiscovery: false,
    contentDiscovery: true,
    metadata: true,
    videos: false,
    images: true,
    comments: false,
    performance: true,
    webpages: false,
    search: false,
  };

  private readonly config?: CycloneGatewayConfig;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options?: { config?: CycloneGatewayConfig; fetchFn?: typeof fetch; timeoutMs?: number }) {
    this.fetchFn = options?.fetchFn ?? globalThis.fetch;
    this.timeoutMs = options?.timeoutMs ?? CYCLONE_REQUEST_TIMEOUT_MS;
    if (options?.config) {
      this.config = options.config;
    } else {
      const gatewayUrl = cycloneGatewayUrlSetting();
      const deviceId = cycloneDeviceIdSetting();
      if (gatewayUrl && deviceId) this.config = { gatewayUrl, apiKey: cycloneApiKey(), deviceId };
    }
  }

  async health(): Promise<SourceHealth> {
    const lastCheckedAt = new Date().toISOString();
    if (!this.config?.gatewayUrl || !this.config.deviceId) {
      return { adapterId: this.id, status: "NOT_CONFIGURED", latencyMs: 0, message: "Cyclone Gateway or Device ID not set", lastCheckedAt };
    }
    const started = Date.now();
    const conn = await this.checkConnection();
    const latencyMs = Date.now() - started;
    if (conn.connected) {
      return { adapterId: this.id, status: "HEALTHY", latencyMs, message: `Device ${this.config.deviceId} status: ${conn.deviceStatus}`, lastCheckedAt };
    }
    return { adapterId: this.id, status: "UNAVAILABLE", latencyMs, message: conn.reason || "Device not connected", lastCheckedAt };
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
      evidenceAvailability: evidenceOf(r),
      metadata: {
        niche: r.niche,
        author: r.creatorHandle,
        caption: r.caption,
        metrics: r.metrics,
        screenshotUrl: r.screenshotUrl,
        screenshotArtifactId: r.screenshotArtifactId,
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

  /**
   * Whether this device is reachable through the gateway now. Connected only when the gateway names this device: its own status, or the
   * fleet list that contains it. A gateway that answers for something else (a capability list, a health route) does not connect the device.
   */
  async checkConnection(): Promise<CycloneConnectionCheck> {
    const config = this.config;
    if (!config?.gatewayUrl || !config.deviceId) {
      return { connected: false, reason: "CYCLONE_GATEWAY_URL or CYCLONE_DEVICE_ID is not configured." };
    }
    try {
      const status = await this.request(`/v1/device/status?device_id=${encodeURIComponent(config.deviceId)}`);
      if (status.ok) return connectionOfDevice(await readRecord(status), config.deviceId);

      const fleet = await this.request("/v1/devices");
      if (fleet.ok) {
        const body = await readRecord(fleet);
        const list = Array.isArray(body.devices) ? body.devices : null;
        const target = list?.map(asRecord).find((device) => (device.deviceId ?? device.device_id) === config.deviceId);
        if (target) return connectionOfDevice(target, config.deviceId);
        if (list) return { connected: false, reason: `Device ${config.deviceId} is not registered in the Cyclone gateway's fleet.` };
      }
      return {
        connected: false,
        reason: `Device ${config.deviceId} could not be verified: the gateway answered HTTP ${status.status} for its status and HTTP ${fleet.status} for the fleet.`,
      };
    } catch (err) {
      return { connected: false, reason: `Failed to contact Cyclone Gateway: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** One observation of the feed: the cards the device shows, read into reels. Throws when the gateway does not answer. */
  async observeFeed(request: { niche: string; budget?: number; sessionId?: string; includeScreenshot?: boolean }): Promise<DiscoveredReelItem[]> {
    const config = this.config;
    if (!config?.gatewayUrl || !config.deviceId) throw new Error("Cyclone Gateway or Device is not configured.");
    const sessionId = request.sessionId || "default-foreground";
    const payload = JSON.stringify({
      device_id: config.deviceId,
      session_id: sessionId,
      mode: "compact",
      include_screenshot: request.includeScreenshot ?? true,
      niche: request.niche,
      budget: request.budget || 5,
    });

    let res = await this.request("/v1/capabilities/observe", { method: "POST", body: payload });
    // The gateway's older observe route, for a gateway that does not have the capability route.
    if (!res.ok && res.status === 404) res = await this.request("/v1/observe", { method: "POST", body: payload });
    if (!res.ok) throw new Error(`Failed to observe feed via Cyclone: HTTP ${res.status}`);

    const body = await readRecord(res);
    const cards = pageCardsOf(body);
    const observedAt = textOf(body.observed_at) ?? textOf(body.timestamp);
    const screenshotUrl = webUrlOf(body.screenshot_url) ?? webUrlOf(body.screenshot);
    const screenshotArtifactId = identifierOf(body.screenshot_id) ?? (identifierOf(body.screenshot_path) ? `cyclone-${identifierOf(body.screenshot_path)}` : undefined);

    const reels: DiscoveredReelItem[] = [];
    for (const card of cards) {
      const reel = this.parsePageCardToReel(card, request.niche, {
        sessionId: textOf(body.session_id) ?? sessionId,
        observedAt,
        screenshotUrl,
        screenshotArtifactId,
      });
      if (reel) reels.push(reel);
    }
    return reels;
  }

  /**
   * Parses one accessibility-tree card (the device's page card) into a reel. Truth first: an unobserved permalink, post date or count stays
   * undefined, and the first-seen time of a sound is the time the screen was observed, which the gateway sent.
   */
  parsePageCardToReel(
    card: CyclonePageCard,
    niche: string,
    context?: { sessionId?: string; observedAt?: string; screenshotUrl?: string; screenshotArtifactId?: string },
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
      } else if (/^[0-9.,]+[KMB]?\s*(views|plays)$/i.test(text)) {
        views = parseMetricNumber(text);
      } else if (/^[0-9.,]+[KMB]?\s*likes$/i.test(text)) {
        likes = parseMetricNumber(text);
      } else if (/^[0-9.,]+[KMB]?\s*comments$/i.test(text)) {
        comments = parseMetricNumber(text);
      } else if (text.startsWith("https://www.instagram.com/reel/")) {
        permalink = text;
      }
    }

    // The post id is taken only from a permalink that was on screen.
    const externalPostId = permalink ? permalink.split("/reel/")[1]?.replace(/\/$/, "") : undefined;
    const fingerprint = createHash("sha256").update([creatorHandle, textNodes.slice(0, 5).join(" ")].join(":")).digest("hex").slice(0, 12);

    return {
      id: `scout-${this.config?.deviceId ?? "dev"}-${fingerprint}`,
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
        firstSeenAt: context?.observedAt,
      } satisfies DiscoveredAudioTrend,
      durationMs: undefined,
      postedAt: undefined, // capture time is kept apart from the original post time
      discoveredAt: new Date().toISOString(),
      discoveryTier: "cyclone_scout",
      scoutDeviceId: this.config?.deviceId,
      scoutSessionId: context?.sessionId,
      scoutObservationTime: context?.observedAt,
      screenshotUrl: webUrlOf(context?.screenshotUrl),
      screenshotArtifactId: identifierOf(context?.screenshotArtifactId),
      metrics: {
        views: views !== undefined && views > 0 ? views : undefined,
        likes: likes !== undefined && likes > 0 ? likes : undefined,
        comments: comments !== undefined && comments > 0 ? comments : undefined,
      },
    };
  }

  /** One request to the gateway, with the device's headers and a time limit, so a silent gateway cannot hold a run open. */
  private request(path: string, init: { method?: "GET" | "POST"; body?: string } = {}): Promise<Response> {
    const base = (this.config?.gatewayUrl ?? "").replace(/\/+$/, "");
    return this.fetchFn(`${base}${path}`, {
      method: init.method ?? "GET",
      headers: this.getHeaders(),
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Cyclone-Protocol": "cyclone.gateway.capability.v1",
    };
    if (this.config?.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
    return headers;
  }
}

/** The device's own status, read as the gateway sent it. Connected unless the gateway says the device is offline or in error. */
function connectionOfDevice(body: Record<string, unknown>, deviceId: string): CycloneConnectionCheck {
  const status = textOf(body.status) ?? (body.connected === false ? "offline" : undefined);
  if (body.connected === false || status === "offline" || status === "error") {
    return { connected: false, deviceStatus: status ?? "offline", reason: `Device ${deviceId} is ${status ?? "offline"} at the gateway.` };
  }
  return { connected: true, deviceStatus: status ?? "unreported" };
}

/** The evidence a reference carries, from what was observed: a screenshot, then the text on screen, then nothing but the reference. */
export function evidenceOf(item: DiscoveredReelItem): EvidenceAvailability {
  if (item.screenshotUrl || item.screenshotArtifactId) return "MEDIA_AVAILABLE";
  if (item.caption || item.creatorHandle !== "unknown_creator") return "METADATA_AVAILABLE";
  return "REFERENCE_ONLY";
}

function pageCardsOf(body: Record<string, unknown>): CyclonePageCard[] {
  const cards: unknown[] = [];
  for (const key of ["page_cards", "pageCards", "candidates"]) {
    const value = body[key];
    if (Array.isArray(value)) cards.push(...value);
  }
  for (const key of ["page_card", "card"]) if (body[key] !== undefined) cards.push(body[key]);
  return cards.map(asRecord).filter((card) => typeof card.role === "string").map(toCard);
}

function toCard(value: Record<string, unknown>): CyclonePageCard {
  const children = Array.isArray(value.children) ? value.children.map(asRecord).map(toCard) : undefined;
  return {
    nodeId: String(value.nodeId ?? ""),
    role: String(value.role ?? ""),
    text: textOf(value.text),
    contentDescription: textOf(value.contentDescription),
    children,
  };
}

function collectText(node: CyclonePageCard, acc: string[]): void {
  if (node.text && node.text.trim()) acc.push(node.text.trim());
  if (node.contentDescription && node.contentDescription.trim()) acc.push(node.contentDescription.trim());
  for (const child of node.children ?? []) collectText(child, acc);
}

/** A web address the gateway sent, or undefined. Only http and https are kept, and a long value is not. Anything else is data we drop. */
export function webUrlOf(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_CHARS) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function identifierOf(value: unknown): string | undefined {
  const text = textOf(value);
  return text && text.length <= 200 ? text : undefined;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The gateway's JSON body as a record. A body that is not JSON is an empty record: nothing in it is then taken as observed. */
async function readRecord(res: Response): Promise<Record<string, unknown>> {
  return asRecord(await res.json().catch(() => ({})));
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
