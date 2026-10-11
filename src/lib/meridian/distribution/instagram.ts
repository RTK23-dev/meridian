import { createHash } from "node:crypto";
import { liveTransport, type Transport, type TransportRequest } from "../providers/http.ts";
import { isTestingRuntimeNow } from "../runtime-mode.ts";
import { GRAPH_BASE, classifyFailure, failure, parseJsonBody, responseId, unconfirmed } from "./graph.ts";
import type {
  ConnectionCheck,
  DistributionChannel,
  OrganicConnection,
  OrganicPublishRequest,
  OrganicPublishReceipt,
  OrganicTelemetryMetrics,
} from "./types.ts";

const LABEL = "Instagram";
const NOT_CONNECTED_REASON =
  "No Instagram account is connected for this brand. Add the Instagram account ID and an access token with content publishing permission in Accounts.";
const NO_PUBLIC_URL_REASON =
  "Instagram Reels needs a public https URL for the video. Meridian does not serve stored media at a public URL yet, so nothing was sent. Export the package and post it by hand.";

export type InstagramOptions = {
  transport?: Transport;
  sleep?: (ms: number) => Promise<void>;
  /** How many times the container status is checked before the publish is abandoned. */
  polls?: number;
  pollIntervalMs?: number;
};

/**
 * Publishes a Reel through the Instagram container flow: create a container from a public video URL, wait until it is
 * FINISHED, then publish it. The receipt id is the media id the publish call returns. The channel reports NOT_CONNECTED
 * until a connected account and a public video URL are both present, so the flow runs only with a real account and a real URL.
 */
export class InstagramReelsChannel implements DistributionChannel {
  public readonly id = "instagram-reels";
  public readonly platform = "instagram" as const;
  public readonly targetType = "organic_post" as const;
  public readonly displayName = "Instagram Reels & Feed";

  private readonly options: Required<Omit<InstagramOptions, "transport">> & { transport: Transport };

  constructor(options: InstagramOptions = {}) {
    this.options = {
      transport: options.transport ?? liveTransport(),
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      polls: options.polls ?? 20,
      pollIntervalMs: options.pollIntervalMs ?? 3000,
    };
  }

  checkConnection(connection: OrganicConnection | undefined): ConnectionCheck {
    if (connection?.connected) return { connected: true, accountName: connection.accountName };
    return { connected: false, code: "NOT_CONNECTED", reason: connection?.reason ?? NOT_CONNECTED_REASON };
  }

  async publish(request: OrganicPublishRequest): Promise<OrganicPublishReceipt> {
    if (!request.mediaBytes || request.mediaBytes.byteLength === 0) {
      return failure("instagram", "REJECTED", "Media bytes cannot be empty.");
    }
    if (!request.mimeType.startsWith("video/") && !request.mimeType.startsWith("image/")) {
      return failure("instagram", "REJECTED", `Unsupported MIME type for Instagram: ${request.mimeType}`);
    }

    const connection = request.connection;
    if (!connection?.connected) {
      if (request.allowTestProvider && isTestingRuntimeNow()) {
        const sha256 = createHash("sha256").update(request.mediaBytes).digest("hex");
        const mockExternalId = `ig_test_${sha256.slice(0, 12)}`;
        return {
          externalId: mockExternalId,
          postUrl: `https://www.instagram.com/reel/${mockExternalId}/`,
          platform: "instagram",
          status: "published",
          publishedAt: new Date().toISOString(),
        };
      }
      return failure("instagram", "NOT_CONNECTED", this.checkConnection(connection).reason ?? NOT_CONNECTED_REASON);
    }

    if (!request.mimeType.startsWith("video/")) {
      return failure("instagram", "REJECTED", `An Instagram Reel needs a video file (received ${request.mimeType}).`);
    }
    if (request.scheduledFor) {
      return failure("instagram", "REJECTED", "Instagram Reels cannot be scheduled by this channel yet. Publish now, or export the package and post it by hand.");
    }
    const videoUrl = publicVideoUrl(request.metadata);
    if (!videoUrl) return failure("instagram", "NOT_CONNECTED", NO_PUBLIC_URL_REASON);

    return publishInstagramReel(this.options, {
      igUserId: connection.accountId,
      accessToken: connection.accessToken,
      videoUrl,
      caption: request.caption,
    });
  }

  async fetchMetrics(externalId: string): Promise<OrganicTelemetryMetrics | null> {
    // Live metrics are not implemented in this build. Nothing is observed, so nothing is returned: no fixed
    // numbers stand in for engagement.
    void externalId;
    return null;
  }
}

/** The public https URL the container fetches the video from. Anything else is not accepted. */
export function publicVideoUrl(metadata: Record<string, unknown> | undefined): string {
  const value = metadata?.publicVideoUrl;
  return typeof value === "string" && value.startsWith("https://") ? value : "";
}

type Sent = { ok: true; json: unknown } | { ok: false; receipt: OrganicPublishReceipt };

/** One request. A transport error or a refusal becomes a failed receipt. `uploadStarted` marks steps after which content may be accepted. */
async function send(transport: Transport, request: TransportRequest, uploadStarted: boolean): Promise<Sent> {
  let response;
  try {
    response = await transport(request);
  } catch {
    return { ok: false, receipt: failure("instagram", "UNCONFIRMED", unconfirmed(LABEL, "no response arrived")) };
  }
  const json = parseJsonBody(response.body);
  if (response.status < 200 || response.status >= 300) {
    const refused = classifyFailure({ label: LABEL, response, json, uploadStarted });
    return { ok: false, receipt: failure("instagram", refused.code, refused.error) };
  }
  return { ok: true, json };
}

/** The container flow. Each step is one request, and a failed step stops the flow with the reason. */
export async function publishInstagramReel(
  options: Required<Omit<InstagramOptions, "transport">> & { transport: Transport },
  input: { igUserId: string; accessToken: string; videoUrl: string; caption: string },
  now: Date = new Date(),
): Promise<OrganicPublishReceipt> {
  const headers = { Authorization: `Bearer ${input.accessToken}` };
  const account = encodeURIComponent(input.igUserId);

  const created = await send(
    options.transport,
    {
      method: "POST",
      url: `${GRAPH_BASE}/${account}/media`,
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ media_type: "REELS", video_url: input.videoUrl, caption: input.caption.slice(0, 2200) }).toString(),
    },
    false,
  );
  if (!created.ok) return created.receipt;
  const containerId = responseId(created.json);
  if (!containerId) return failure("instagram", "UNCONFIRMED", unconfirmed(LABEL, "the container response had no id"));

  let finished = false;
  for (let attempt = 0; attempt < options.polls; attempt += 1) {
    const status = await send(
      options.transport,
      { method: "GET", url: `${GRAPH_BASE}/${encodeURIComponent(containerId)}?fields=status_code`, headers },
      false,
    );
    if (!status.ok) return status.receipt;
    const code = (status.json as { status_code?: unknown } | null)?.status_code;
    if (code === "FINISHED") {
      finished = true;
      break;
    }
    if (code === "ERROR" || code === "EXPIRED") {
      return failure("instagram", "REJECTED", `Instagram could not process the video (status ${code}). Nothing was published.`);
    }
    if (attempt < options.polls - 1) await options.sleep(options.pollIntervalMs);
  }
  if (!finished) {
    return failure("instagram", "RETRYABLE", "Instagram is still processing the video. Nothing was published. Try again later.");
  }

  const published = await send(
    options.transport,
    {
      method: "POST",
      url: `${GRAPH_BASE}/${account}/media_publish`,
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ creation_id: containerId }).toString(),
    },
    true,
  );
  if (!published.ok) return published.receipt;
  const mediaId = responseId(published.json);
  if (!mediaId) return failure("instagram", "UNCONFIRMED", unconfirmed(LABEL, "the publish response had no media id"));
  return { externalId: mediaId, platform: "instagram", status: "published", publishedAt: now.toISOString() };
}
