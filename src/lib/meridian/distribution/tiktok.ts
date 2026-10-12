/**
 * TikTok regular-video channel, built to TikTok's Content Posting API (video init, a single-chunk file upload, then status checks).
 *
 * TikTok accepts the upload before the post exists, so a publish is reported as published only when a status check returns
 * PUBLISH_COMPLETE. While TikTok is still processing the upload, the status is checked again, up to a fixed number of times. Any
 * other state is reported as unconfirmed, so a post is never claimed that TikTok has not made, and the person is asked to check
 * the account before trying again. Until TikTok approves the app for public posting, the post is sent as private (SELF_ONLY).
 * Nothing here has been checked against TikTok's live service: that needs an approved app and a connected account.
 */

import { createHash } from "node:crypto";
import { liveTransport, type Transport } from "../providers/http.ts";
import { isTestingRuntimeNow } from "../runtime-mode.ts";
import { TIKTOK_POSTING_SCOPE } from "./connection.ts";
import { classifyFailure, failure, parseJsonBody, unconfirmed } from "./graph.ts";
import type {
  ConnectionCheck,
  DistributionChannel,
  OrganicConnection,
  OrganicPublishRequest,
  OrganicPublishReceipt,
  OrganicTelemetryMetrics,
} from "./types.ts";

const LABEL = "TikTok";
const INIT_URL = "https://open.tiktokapis.com/v2/post/publish/video/init/";
const STATUS_URL = "https://open.tiktokapis.com/v2/post/publish/status/fetch/";
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_CAPTION = 2200;
const VIDEO_TYPES = ["video/mp4", "video/quicktime"];
/** The states in which TikTok is still working on the upload. Any other state is reported as it is. */
const PROCESSING_STATES = new Set(["PROCESSING_UPLOAD", "PROCESSING_DOWNLOAD"]);
const DEFAULT_POLLS = 12;
const POLL_INTERVAL_MS = 5_000;
const NOT_CONNECTED_REASON =
  `No TikTok account is connected for this brand. Connect it in Accounts with a token that grants ${TIKTOK_POSTING_SCOPE}.`;

type Tiktok = { data?: Record<string, unknown>; error?: { code?: string; message?: string } };

export type TikTokDeps = {
  transport: Transport;
  sleep: (ms: number) => Promise<void>;
  /** How many status checks run while TikTok is still processing the upload. */
  polls: number;
};

type StatusReading = { status: string; postId: string };

/** The video is sent in one chunk, so the upload is a single request after the init. */
export async function publishTikTokVideo(
  deps: TikTokDeps,
  input: { accessToken: string; mediaBytes: Uint8Array; mimeType: string; caption: string },
): Promise<OrganicPublishReceipt> {
  const size = input.mediaBytes.byteLength;
  if (size > MAX_BYTES) return failure("tiktok", "REJECTED", "TikTok accepts videos up to 64 MB through this channel.");

  const authorization = `Bearer ${input.accessToken}`;
  let init;
  try {
    init = await deps.transport({
      method: "POST",
      url: INIT_URL,
      headers: { Authorization: authorization, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({
        post_info: {
          title: input.caption.slice(0, MAX_CAPTION),
          privacy_level: "SELF_ONLY",
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
        },
        source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: size, total_chunk_count: 1 },
      }),
    });
  } catch {
    return failure("tiktok", "UNCONFIRMED", unconfirmed(LABEL, "no response arrived"));
  }
  const initJson = parseJsonBody(init.body) as Tiktok | null;
  if (init.status < 200 || init.status >= 300) {
    // No bytes have been sent yet, so a server error here is safe to retry later.
    const refused = classifyFailure({ label: LABEL, response: init, json: initJson, uploadStarted: false });
    return failure("tiktok", refused.code, refused.error);
  }
  const publishId = typeof initJson?.data?.publish_id === "string" ? initJson.data.publish_id : "";
  const uploadUrl = typeof initJson?.data?.upload_url === "string" ? initJson.data.upload_url : "";
  if (!publishId || !uploadUrl) return failure("tiktok", "UNCONFIRMED", unconfirmed(LABEL, "no publish id or upload address was returned"));

  let uploaded;
  try {
    uploaded = await deps.transport({
      method: "PUT",
      url: uploadUrl,
      headers: { "Content-Type": input.mimeType, "Content-Length": String(size), "Content-Range": `bytes 0-${size - 1}/${size}` },
      body: input.mediaBytes,
    });
  } catch {
    return failure("tiktok", "UNCONFIRMED", unconfirmed(LABEL, "the upload did not get a response"));
  }
  // The bytes have been sent, so a refusal here is not safe to report as a clean failure: TikTok may still post the video.
  if (uploaded.status < 200 || uploaded.status >= 300) {
    return failure("tiktok", "UNCONFIRMED", unconfirmed(LABEL, `the upload returned ${uploaded.status}`));
  }
  return settlePublish(deps, authorization, publishId);
}

/**
 * Checks the status until TikTok stops processing the upload, then reports the last state it gave. A state other than
 * processing is not checked again, so an inbox delivery or a failure is reported as TikTok states it.
 */
async function settlePublish(deps: TikTokDeps, authorization: string, publishId: string): Promise<OrganicPublishReceipt> {
  let reading = await readStatus(deps.transport, authorization, publishId);
  for (let check = 1; check < deps.polls && reading && PROCESSING_STATES.has(reading.status); check += 1) {
    await deps.sleep(POLL_INTERVAL_MS);
    reading = await readStatus(deps.transport, authorization, publishId);
  }
  return statusReceipt(reading, publishId);
}

/** One status check. Null when TikTok did not answer with a state. */
async function readStatus(transport: Transport, authorization: string, publishId: string): Promise<StatusReading | null> {
  let response;
  try {
    response = await transport({
      method: "POST",
      url: STATUS_URL,
      headers: { Authorization: authorization, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ publish_id: publishId }),
    });
  } catch {
    return null;
  }
  const json = parseJsonBody(response.body) as Tiktok | null;
  const status = typeof json?.data?.status === "string" ? json.data.status : "";
  if (!status) return null;
  const ids = json?.data?.publicaly_available_post_id;
  const postId = Array.isArray(ids) && typeof ids[0] === "string" ? ids[0] : "";
  return { status, postId };
}

/**
 * Only PUBLISH_COMPLETE is a published post. The post id is TikTok's public post id. When TikTok returns none, the publish id
 * stands in, so the receipt still names the upload.
 */
function statusReceipt(reading: StatusReading | null, publishId: string): OrganicPublishReceipt {
  if (!reading) return failure("tiktok", "UNCONFIRMED", unconfirmed(LABEL, "the status check did not return a state"));
  if (reading.status === "PUBLISH_COMPLETE") {
    return {
      externalId: reading.postId || publishId,
      platform: "tiktok",
      status: "published",
      publishedAt: new Date().toISOString(),
    };
  }
  if (reading.status === "FAILED") return failure("tiktok", "REJECTED", "TikTok could not post this video.");
  const state = reading.status.toLowerCase().replace(/_/g, " ");
  return failure("tiktok", "UNCONFIRMED", unconfirmed(LABEL, `TikTok reports ${state} for this upload`));
}

export class TikTokOrganicChannel implements DistributionChannel {
  public readonly id = "tiktok-organic";
  public readonly platform = "tiktok" as const;
  public readonly targetType = "organic_post" as const;
  public readonly displayName = "TikTok (regular video)";

  private readonly deps: TikTokDeps;

  constructor(options: { transport?: Transport; sleep?: (ms: number) => Promise<void>; polls?: number } = {}) {
    this.deps = {
      transport: options.transport ?? liveTransport(),
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      polls: options.polls ?? DEFAULT_POLLS,
    };
  }

  checkConnection(connection: OrganicConnection | undefined): ConnectionCheck {
    if (connection?.connected) return { connected: true, accountName: connection.accountName };
    return { connected: false, code: "NOT_CONNECTED", reason: connection?.reason ?? NOT_CONNECTED_REASON };
  }

  async publish(request: OrganicPublishRequest): Promise<OrganicPublishReceipt> {
    if (!request.mediaBytes || request.mediaBytes.byteLength === 0) {
      return failure("tiktok", "REJECTED", "Media bytes cannot be empty.");
    }
    if (!VIDEO_TYPES.includes(request.mimeType)) {
      return failure("tiktok", "REJECTED", `TikTok accepts MP4 or MOV video only (received ${request.mimeType}).`);
    }
    if (request.scheduledFor) {
      return failure("tiktok", "REJECTED", "TikTok posts cannot be scheduled by this channel yet. Publish now, or export the package and post it by hand.");
    }

    const connection = request.connection;
    if (!connection?.connected) {
      if (request.allowTestProvider && isTestingRuntimeNow()) {
        const testId = `tt_test_${createHash("sha256").update(request.mediaBytes).digest("hex").slice(0, 11)}`;
        return { externalId: testId, platform: "tiktok", status: "published", publishedAt: new Date().toISOString() };
      }
      return failure("tiktok", "NOT_CONNECTED", this.checkConnection(connection).reason ?? NOT_CONNECTED_REASON);
    }
    if (connection.scopes && !connection.scopes.includes(TIKTOK_POSTING_SCOPE)) {
      return failure("tiktok", "NOT_CONNECTED", `The stored TikTok token does not grant ${TIKTOK_POSTING_SCOPE}. Reconnect the account with that permission.`);
    }

    return publishTikTokVideo(this.deps, {
      accessToken: connection.accessToken,
      mediaBytes: request.mediaBytes,
      mimeType: request.mimeType,
      caption: request.caption,
    });
  }

  async fetchMetrics(externalId: string): Promise<OrganicTelemetryMetrics | null> {
    // Live metrics are not implemented for TikTok in this build, so nothing is returned.
    void externalId;
    return null;
  }
}
