import { createHash } from "node:crypto";
import { gatedTransport, isCapabilityDisabledError } from "../providers/capability.ts";
import type { Transport } from "../providers/http.ts";
import { isTestingRuntimeNow } from "../runtime-mode.ts";
import { YOUTUBE_READ_SCOPES, YOUTUBE_UPLOAD_SCOPE } from "./connection.ts";
import { classifyFailure, failure, parseJsonBody, responseId, unconfirmed } from "./graph.ts";
import { readYouTubeMetrics } from "./metric-reads.ts";
import type {
  ConnectionCheck,
  DistributionChannel,
  OrganicConnection,
  OrganicMetricsReading,
  OrganicPublishRequest,
  OrganicPublishReceipt,
} from "./types.ts";

const LABEL = "YouTube";
const UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";
const NOT_CONNECTED_REASON =
  `No YouTube channel is connected for this brand. Add the channel ID and a token that grants ${YOUTUBE_UPLOAD_SCOPE} in Accounts.`;

/**
 * Uploads a Short to a connected YouTube channel with the Data API resumable upload: one request opens the session, a second
 * sends the bytes. The receipt id is the video id the upload response returns. Uploads are public, because the receipt says
 * published. Without a connection, or a token that lacks the upload scope, the channel reports NOT_CONNECTED and sends nothing.
 */
export class YouTubeShortsChannel implements DistributionChannel {
  public readonly id = "youtube-shorts";
  public readonly platform = "youtube" as const;
  public readonly targetType = "organic_post" as const;
  public readonly displayName = "YouTube Shorts & Video";

  private readonly transport: Transport;

  constructor(options: { transport?: Transport } = {}) {
    this.transport = options.transport ?? gatedTransport("publish.youtube");
  }

  checkConnection(connection: OrganicConnection | undefined): ConnectionCheck {
    if (connection?.connected) return { connected: true, accountName: connection.accountName };
    return { connected: false, code: "NOT_CONNECTED", reason: connection?.reason ?? NOT_CONNECTED_REASON };
  }

  async publish(request: OrganicPublishRequest): Promise<OrganicPublishReceipt> {
    if (!request.mediaBytes || request.mediaBytes.byteLength === 0) {
      return failure("youtube", "REJECTED", "Media bytes cannot be empty.");
    }
    if (!request.mimeType.startsWith("video/")) {
      return failure("youtube", "REJECTED", `YouTube accepts video files only (received ${request.mimeType}).`);
    }

    const connection = request.connection;
    if (!connection?.connected) {
      if (request.allowTestProvider && isTestingRuntimeNow()) {
        const sha256 = createHash("sha256").update(request.mediaBytes).digest("hex");
        const mockExternalId = `yt_test_${sha256.slice(0, 11)}`;
        return {
          externalId: mockExternalId,
          postUrl: `https://www.youtube.com/shorts/${mockExternalId}`,
          platform: "youtube",
          status: "published",
          publishedAt: new Date().toISOString(),
        };
      }
      return failure("youtube", "NOT_CONNECTED", this.checkConnection(connection).reason ?? NOT_CONNECTED_REASON);
    }

    if (request.scheduledFor) {
      return failure("youtube", "REJECTED", "YouTube Shorts cannot be scheduled by this channel yet. Publish now, or export the package and post it by hand.");
    }
    return uploadYouTubeShort(this.transport, {
      accessToken: connection.accessToken,
      mediaBytes: request.mediaBytes,
      mimeType: request.mimeType,
      title: request.title ?? "",
      description: request.caption,
    });
  }

  /** Reads the public statistics of a Short. A token that declares no read scope is not connected for reads, so no request is sent. */
  async fetchMetrics(externalId: string, connection: OrganicConnection | undefined): Promise<OrganicMetricsReading> {
    if (!connection?.connected) {
      return { status: "not_connected", reason: this.checkConnection(connection).reason ?? NOT_CONNECTED_REASON };
    }
    if (connection.scopes && !connection.scopes.some((scope) => YOUTUBE_READ_SCOPES.includes(scope))) {
      return {
        status: "not_connected",
        reason: `The saved YouTube token does not grant a read scope (${YOUTUBE_READ_SCOPES[0]}), so no metric was requested. Save a token that grants one in Accounts.`,
      };
    }
    return readYouTubeMetrics(this.transport, { externalId, accessToken: connection.accessToken }, new Date());
  }
}

/**
 * Opens a resumable upload session, then sends the video bytes to it. Nothing is retried after the bytes are sent. A failure
 * before the session opens is safe to retry, and the receipt says so.
 */
export async function uploadYouTubeShort(
  transport: Transport,
  input: { accessToken: string; mediaBytes: Uint8Array; mimeType: string; title: string; description: string },
): Promise<OrganicPublishReceipt> {
  const title = input.title.replace(/\s+/g, " ").trim().slice(0, 100) || "Meridian Short";
  const metadata = JSON.stringify({
    snippet: { title, description: input.description.slice(0, 5000), categoryId: "22" },
    status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
  });

  let session;
  try {
    session = await transport({
      method: "POST",
      url: UPLOAD_URL,
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(input.mediaBytes.byteLength),
        "X-Upload-Content-Type": input.mimeType,
      },
      body: metadata,
    });
  } catch (error) {
    // A disabled path sent nothing, so there is no unknown outcome to check on YouTube.
    if (isCapabilityDisabledError(error)) return failure("youtube", "NOT_CONNECTED", error.message);
    return failure("youtube", "UNCONFIRMED", unconfirmed(LABEL, "no response arrived"));
  }
  if (session.status < 200 || session.status >= 300) {
    const refused = classifyFailure({ label: LABEL, response: session, json: parseJsonBody(session.body), uploadStarted: false });
    return failure("youtube", refused.code, refused.error);
  }
  const sessionUrl = session.headers.location?.trim() ?? "";
  if (!sessionUrl) return failure("youtube", "UNCONFIRMED", unconfirmed(LABEL, "no upload session was returned"));

  let uploaded;
  try {
    uploaded = await transport({
      method: "PUT",
      url: sessionUrl,
      headers: { "Content-Type": input.mimeType },
      body: input.mediaBytes,
    });
  } catch (error) {
    if (isCapabilityDisabledError(error)) return failure("youtube", "NOT_CONNECTED", error.message);
    return failure("youtube", "UNCONFIRMED", unconfirmed(LABEL, "the upload did not get a response"));
  }
  const json = parseJsonBody(uploaded.body);
  if (uploaded.status < 200 || uploaded.status >= 300) {
    const refused = classifyFailure({ label: LABEL, response: uploaded, json, uploadStarted: true });
    return failure("youtube", refused.code, refused.error);
  }
  const id = responseId(json);
  if (!id) return failure("youtube", "UNCONFIRMED", unconfirmed(LABEL, "the response had no video id"));
  return {
    externalId: id,
    postUrl: `https://www.youtube.com/shorts/${encodeURIComponent(id)}`,
    platform: "youtube",
    status: "published",
    publishedAt: new Date().toISOString(),
  };
}
