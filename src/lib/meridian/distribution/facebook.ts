import { createHash } from "node:crypto";
import { liveTransport, type Transport } from "../providers/http.ts";
import { isTestingRuntimeNow } from "../runtime-mode.ts";
import { GRAPH_BASE, classifyFailure, failure, parseJsonBody, responseId, unconfirmed } from "./graph.ts";
import type {
  ConnectionCheck,
  DistributionChannel,
  OrganicConnection,
  OrganicMetricsReading,
  OrganicPublishRequest,
  OrganicPublishReceipt,
} from "./types.ts";

const LABEL = "Facebook Page";
const NOT_CONNECTED_REASON = "No Facebook Page is connected for this brand. Add the Page ID and a Page access token in Accounts.";
const FACEBOOK_METRICS_NOT_IMPLEMENTED =
  "Facebook Page video metrics are not implemented in this build, so no request was sent and nothing was stored.";
const MIN_SCHEDULE_AHEAD_MS = 10 * 60 * 1000;
const MAX_SCHEDULE_AHEAD_MS = 75 * 24 * 60 * 60 * 1000;

/**
 * Publishes a video to a connected Facebook Page. The only receipt id is the one the Graph API returns for the video. Without a
 * connection the channel reports NOT_CONNECTED and sends nothing. The test receipt is only produced in the testing runtime.
 */
export class FacebookPagesChannel implements DistributionChannel {
  public readonly id = "facebook-pages";
  public readonly platform = "facebook" as const;
  public readonly targetType = "organic_post" as const;
  public readonly displayName = "Facebook Page Video & Reels";

  private readonly transport: Transport;

  constructor(options: { transport?: Transport } = {}) {
    this.transport = options.transport ?? liveTransport();
  }

  checkConnection(connection: OrganicConnection | undefined): ConnectionCheck {
    if (connection?.connected) return { connected: true, accountName: connection.accountName };
    return { connected: false, code: "NOT_CONNECTED", reason: connection?.reason ?? NOT_CONNECTED_REASON };
  }

  async publish(request: OrganicPublishRequest): Promise<OrganicPublishReceipt> {
    if (!request.mediaBytes || request.mediaBytes.byteLength === 0) {
      return failure("facebook", "REJECTED", "Media bytes cannot be empty.");
    }
    const connection = request.connection;
    if (!connection?.connected) {
      if (request.allowTestProvider && isTestingRuntimeNow()) return testReceipt(request.mediaBytes);
      return failure("facebook", "NOT_CONNECTED", this.checkConnection(connection).reason ?? NOT_CONNECTED_REASON);
    }
    if (!request.mimeType.startsWith("video/")) {
      return failure("facebook", "REJECTED", `A Facebook Page video needs a video file (received ${request.mimeType}).`);
    }
    return publishFacebookPageVideo(this.transport, {
      pageId: connection.accountId,
      accessToken: connection.accessToken,
      mediaBytes: request.mediaBytes,
      mimeType: request.mimeType,
      caption: request.caption,
      title: request.title ?? "",
      scheduledFor: request.scheduledFor,
    });
  }

  /**
   * Not implemented. The Page video insights reference names post_video_* metrics that were not confirmed for a Page video, and the
   * Video node carries no view or like counts, so no request is built. A connected Page still gets this reason, not a success.
   */
  async fetchMetrics(externalId: string, connection: OrganicConnection | undefined): Promise<OrganicMetricsReading> {
    void externalId;
    if (!connection?.connected) {
      return { status: "not_connected", reason: this.checkConnection(connection).reason ?? NOT_CONNECTED_REASON };
    }
    return { status: "not_implemented", reason: FACEBOOK_METRICS_NOT_IMPLEMENTED };
  }
}

/** One Graph API request that uploads the video to the Page's videos edge. Nothing is retried, so a Page cannot get two posts. */
export async function publishFacebookPageVideo(
  transport: Transport,
  input: {
    pageId: string;
    accessToken: string;
    mediaBytes: Uint8Array;
    mimeType: string;
    caption: string;
    title: string;
    scheduledFor?: string;
  },
  now: Date = new Date(),
): Promise<OrganicPublishReceipt> {
  const schedule = scheduledSeconds(input.scheduledFor, now);
  if ("error" in schedule) return failure("facebook", "REJECTED", schedule.error);

  const form = new FormData();
  form.append("description", input.caption.slice(0, 5000));
  if (input.title.trim()) form.append("title", input.title.trim().slice(0, 255));
  if (schedule.seconds !== null) {
    form.append("published", "false");
    form.append("scheduled_publish_time", String(schedule.seconds));
  }
  form.append("source", new Blob([input.mediaBytes as BlobPart], { type: input.mimeType }), `video.${extensionOf(input.mimeType)}`);

  let response;
  try {
    response = await transport({
      method: "POST",
      url: `${GRAPH_BASE}/${encodeURIComponent(input.pageId)}/videos`,
      headers: { Authorization: `Bearer ${input.accessToken}` },
      body: form,
    });
  } catch {
    return failure("facebook", "UNCONFIRMED", unconfirmed(LABEL, "no response arrived"));
  }

  const json = parseJsonBody(response.body);
  if (response.status < 200 || response.status >= 300) {
    const refused = classifyFailure({ label: LABEL, response, json, uploadStarted: true });
    return failure("facebook", refused.code, refused.error);
  }
  const id = responseId(json);
  if (!id) return failure("facebook", "UNCONFIRMED", unconfirmed(LABEL, "the response had no video id"));

  const scheduled = schedule.seconds !== null;
  return {
    externalId: id,
    postUrl: `https://www.facebook.com/${encodeURIComponent(input.pageId)}/videos/${encodeURIComponent(id)}/`,
    platform: "facebook",
    status: scheduled ? "scheduled" : "published",
    publishedAt: scheduled ? undefined : now.toISOString(),
  };
}

function scheduledSeconds(scheduledFor: string | undefined, now: Date): { seconds: number | null } | { error: string } {
  if (!scheduledFor) return { seconds: null };
  const time = Date.parse(scheduledFor);
  if (!Number.isFinite(time)) return { error: "The scheduled time is not a valid date. Nothing was published." };
  const ahead = time - now.getTime();
  if (ahead < MIN_SCHEDULE_AHEAD_MS || ahead > MAX_SCHEDULE_AHEAD_MS) {
    return { error: "Facebook needs a scheduled time 10 minutes to 75 days ahead. Nothing was published." };
  }
  return { seconds: Math.floor(time / 1000) };
}

function extensionOf(mimeType: string): string {
  const subtype = mimeType.split("/")[1]?.split(";")[0]?.replace(/[^a-z0-9]/gi, "") ?? "";
  return subtype || "mp4";
}

function testReceipt(mediaBytes: Uint8Array): OrganicPublishReceipt {
  const sha256 = createHash("sha256").update(mediaBytes).digest("hex");
  const mockExternalId = `fb_test_${sha256.slice(0, 12)}`;
  return {
    externalId: mockExternalId,
    postUrl: `https://www.facebook.com/watch/?v=${mockExternalId}`,
    platform: "facebook",
    status: "published",
    publishedAt: new Date().toISOString(),
  };
}
