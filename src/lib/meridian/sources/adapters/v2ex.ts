/**
 * V2EX source adapter, for public topics on a node or the hot list.
 *
 * V2EX's public API is read by Agent Reach's V2EX channel inside the sourcing sidecar. Each topic becomes a reference to its page,
 * and the page is read through the same public path as the website adapter, so its text is quarantined. Without the sidecar, the
 * adapter reports that it is not connected.
 */

import { fetchPublicText } from "../fetch-page.server.ts";
import { sidecarConfig, v2exTopicsWithSidecar, type SidecarConfig } from "../sidecar.server.ts";
import { quarantineExternalText } from "../../ingestion/quarantine.ts";
import type {
  DiscoveryQuery,
  RawArtifact,
  SourceAdapter,
  SourceCapabilities,
  SourceHealth,
  SourceReference,
} from "../types.ts";
import { FEED_NOT_CONNECTED } from "./feed.ts";

const NODE_NAME = /^[a-z0-9_-]{1,40}$/;

type V2exDeps = {
  config?: SidecarConfig | null;
  fetchImpl?: typeof fetch;
};

export class V2exSourceAdapter implements SourceAdapter {
  readonly id = "v2ex";
  readonly platform = "v2ex" as const;
  readonly capabilities: SourceCapabilities = {
    profileDiscovery: false,
    contentDiscovery: true,
    metadata: true,
    videos: false,
    images: false,
    comments: false,
    performance: false,
    webpages: true,
    search: false,
  };

  private readonly deps: V2exDeps;

  constructor(deps: V2exDeps = {}) {
    this.deps = deps;
  }

  private config(): SidecarConfig | null {
    return this.deps.config !== undefined ? this.deps.config : sidecarConfig();
  }

  async health(): Promise<SourceHealth> {
    const configured = this.config() !== null;
    return {
      adapterId: this.id,
      status: configured ? "HEALTHY" : "NOT_CONFIGURED",
      latencyMs: 1,
      message: configured ? "Ready to read public V2EX topics through the sourcing sidecar." : FEED_NOT_CONNECTED,
      lastCheckedAt: new Date().toISOString(),
    };
  }

  /** The query names a node (such as "python") or "hot" for the hot list. A free-text query that is not a node name is refused. */
  async discover(query: DiscoveryQuery): Promise<SourceReference[]> {
    const config = this.config();
    if (!config) throw new Error(FEED_NOT_CONNECTED);
    const term = (query.query || "").trim().toLowerCase();
    if (term && term !== "hot" && !NODE_NAME.test(term)) {
      throw new Error("A V2EX query is a node name such as python, or hot for the hot list.");
    }
    const limit = Math.min(query.limit || 20, 50);
    const topics = await v2exTopicsWithSidecar(config, term && term !== "hot" ? term : null, limit, this.deps.fetchImpl);
    if (!topics) throw new Error("The sourcing sidecar could not read V2EX right now. Nothing was stored.");

    const discoveredAt = new Date().toISOString();
    return topics.slice(0, limit).map((topic) => ({
      sourceId: `v2ex_${Buffer.from(topic.url).toString("base64url").slice(0, 32)}`,
      platform: "v2ex",
      sourceAdapter: this.id,
      canonicalUrl: topic.url,
      discoveredAt,
      metadata: { title: topic.title, replies: topic.replies, node: term && term !== "hot" ? term : "hot" },
    }));
  }

  async fetch(reference: SourceReference): Promise<RawArtifact> {
    const url = reference.canonicalUrl || "";
    if (!url) throw new Error("V2EX adapter requires a topic URL.");
    const page = await fetchPublicText(url);
    const cleaned = quarantineExternalText(page.text);
    return {
      id: reference.sourceId,
      reference,
      type: "html",
      mimeType: "text/html",
      textPayload: cleaned.text,
      jsonPayload: { finalUrl: page.url, extractor: page.extractor },
      capturedAt: new Date().toISOString(),
    };
  }
}
