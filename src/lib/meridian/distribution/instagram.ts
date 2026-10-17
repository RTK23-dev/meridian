import { createHash } from "node:crypto";
import { liveTransport, type Transport, type TransportRequest } from "../providers/http.ts";
import { isTestingRuntimeNow } from "../runtime-mode.ts";
import { GRAPH_BASE, TRIAL_GRAPH_BASE, classifyFailure, failure, parseJsonBody, responseId, unconfirmed } from "./graph.ts";
import { INSTAGRAM_PUBLISH_SCOPE } from "./connection.ts";
import { readInstagramMetrics } from "./metric-reads.ts";
import type { TrialReading, TrialRequest } from "./trial.ts";
import type {
  ConnectionCheck,
  DistributionChannel,
  OrganicConnection,
  OrganicMetricsReading,
  OrganicPublishRequest,
  OrganicPublishReceipt,
} from "./types.ts";

const LABEL = "Instagram";
const NOT_CONNECTED_REASON =
  "No Instagram account is connected for this brand. Add the Instagram account ID and an access token with content publishing permission in Accounts.";
const NO_MEDIA_LINK_REASON =
  "No signed media link was made for this Reel, so nothing was sent. Check MEDIA_LINK_SECRET and the public origin on the server.";

export type InstagramOptions = {
  transport?: Transport;
  sleep?: (ms: number) => Promise<void>;
  /** How many times the container status is checked before the publish is abandoned. */
  polls?: number;
  pollIntervalMs?: number;
};

/**
 * Publishes a Reel through the Instagram container flow: create a container from the signed media link, wait until it is
 * FINISHED, then publish it. The receipt id is the media id the publish call returns. The channel reports NOT_CONNECTED
 * until a connected account and an https media link are both present, so the flow runs only with a real account and a real link.
 *
 * Documentation read 2026-10-13:
 *   container: POST /{ig-user-id}/media with media_type=REELS and video_url. The platform cURLs video_url, so it must be public.
 *     https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
 *   status: status_code FINISHED means the upload succeeded.
 *   publish: POST /{ig-user-id}/media_publish with creation_id; the response id is the published media id.
 *     https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media_publish
 * The reference page used Graph v25.0 in its examples. GRAPH_BASE (graph.ts) stays on v21.0 and is not changed here.
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
    if (connection.scopes && !connection.scopes.includes(INSTAGRAM_PUBLISH_SCOPE)) {
      return failure("instagram", "NOT_CONNECTED", `The stored Instagram token does not grant ${INSTAGRAM_PUBLISH_SCOPE}. Reconnect the account with that permission.`);
    }
    if (request.scheduledFor) {
      return failure("instagram", "REJECTED", "Instagram Reels cannot be scheduled by this channel yet. Publish now, or export the package and post it by hand.");
    }
    const videoUrl = httpsMediaUrl(request.mediaUrl);
    if (!videoUrl) return failure("instagram", "NOT_CONNECTED", NO_MEDIA_LINK_REASON);

    return publishInstagramReel(this.options, {
      igUserId: connection.accountId,
      accessToken: connection.accessToken,
      videoUrl,
      caption: request.caption,
      trial: request.trial ?? null,
    });
  }

  /** Reads the media insights of a Reel through the connected account's token. With no connection, no request is sent. */
  async fetchMetrics(externalId: string, connection: OrganicConnection | undefined): Promise<OrganicMetricsReading> {
    if (!connection?.connected) {
      return { status: "not_connected", reason: this.checkConnection(connection).reason ?? NOT_CONNECTED_REASON };
    }
    return readInstagramMetrics(this.options.transport, { externalId, accessToken: connection.accessToken }, new Date());
  }
}

/** The https link the container fetches the video from. Anything else, or nothing, is not sent. */
export function httpsMediaUrl(value: string | undefined): string {
  if (!value) return "";
  try {
    return new URL(value).protocol === "https:" ? value : "";
  } catch {
    return "";
  }
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

/**
 * The container request. An ordinary Reel is form-encoded on GRAPH_BASE, as before. A trial Reel sends the JSON body the trial example
 * documents, with trial_params as a nested object, on TRIAL_GRAPH_BASE.
 */
function containerRequest(
  options: { transport: Transport },
  account: string,
  headers: Record<string, string>,
  input: { videoUrl: string; caption: string; trial: TrialRequest | null },
): TransportRequest {
  const caption = input.caption.slice(0, 2200);
  if (input.trial) {
    return {
      method: "POST",
      url: `${TRIAL_GRAPH_BASE}/${account}/media`,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        media_type: "REELS",
        video_url: input.videoUrl,
        caption,
        trial_params: { graduation_strategy: input.trial.graduationStrategy },
      }),
    };
  }
  return {
    method: "POST",
    url: `${GRAPH_BASE}/${account}/media`,
    headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ media_type: "REELS", video_url: input.videoUrl, caption }).toString(),
  };
}

/** The container flow. Each step is one request, and a failed step stops the flow with the reason. */
export async function publishInstagramReel(
  options: Required<Omit<InstagramOptions, "transport">> & { transport: Transport },
  input: { igUserId: string; accessToken: string; videoUrl: string; caption: string; trial?: TrialRequest | null },
  now: Date = new Date(),
): Promise<OrganicPublishReceipt> {
  const headers = { Authorization: `Bearer ${input.accessToken}` };
  const account = encodeURIComponent(input.igUserId);
  const trial = input.trial ?? null;

  const created = await send(
    options.transport,
    containerRequest(options, account, headers, { videoUrl: input.videoUrl, caption: input.caption, trial }),
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
  // The trial step is a receipt of its own: the media id Meta returned, with the trial it was posted under.
  return {
    externalId: mediaId,
    platform: "instagram",
    status: "published",
    publishedAt: now.toISOString(),
    ...(trial ? { trial } : {}),
  };
}

/**
 * Reads the documented fields of one Reel: whether it still exists, and what Meta reports for feed sharing. The fields are on the IG Media
 * reference (v25.0). No documented field reports trial state or graduation, so none is returned here. A failed read is returned with the
 * reason, not as a state.
 */
export async function readInstagramTrial(transport: Transport, input: { mediaId: string; accessToken: string }): Promise<TrialReading> {
  const sent = await send(
    transport,
    {
      method: "GET",
      url: `${TRIAL_GRAPH_BASE}/${encodeURIComponent(input.mediaId)}?fields=id,media_type,media_product_type,is_shared_to_feed,permalink`,
      headers: { Authorization: `Bearer ${input.accessToken}` },
    },
    false,
  );
  if (!sent.ok) return { ok: false, error: sent.receipt.error ?? unconfirmed(LABEL, "the media read failed") };
  if (responseId(sent.json) !== input.mediaId) {
    return { ok: false, error: unconfirmed(LABEL, "the media read did not return the same media id") };
  }
  const record = (sent.json ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    mediaId: input.mediaId,
    mediaProductType: typeof record.media_product_type === "string" ? record.media_product_type : null,
    isSharedToFeed: typeof record.is_shared_to_feed === "boolean" ? record.is_shared_to_feed : null,
    permalink: typeof record.permalink === "string" ? record.permalink : null,
  };
}
