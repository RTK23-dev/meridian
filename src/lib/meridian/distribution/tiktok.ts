/**
 * TikTok regular-video channel, built to TikTok's Content Posting API with a pull from a signed link. TikTok fetches the video
 * from the media link the service makes (storage/media-link.ts), so the bytes are never sent in this request.
 *
 * Documentation read 2026-10-13:
 *   init: POST https://open.tiktokapis.com/v2/post/publish/video/init/ with scope video.publish. post_info.privacy_level is required.
 *     source_info is {"source": "PULL_FROM_URL", "video_url": ...}. An unverified URL domain returns url_ownership_unverified.
 *     https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
 *   status: POST https://open.tiktokapis.com/v2/post/publish/status/fetch/ with {"publish_id": ...}. data.status is one of
 *     PROCESSING_DOWNLOAD, SEND_TO_USER_INBOX, PUBLISH_COMPLETE, FAILED. data.publicaly_available_post_id is returned only for a
 *     public post that passes moderation. data.fail_reason explains a FAILED status.
 *     https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status
 *   media: the domain must be verified for the app in the TikTok developer portal, the URL must be https and must not redirect, and
 *     it must stay reachable for the download.
 *     https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
 *
 * An unaudited app can post only private content, so the privacy is SELF_ONLY and TikTok returns no public post id. A publish is
 * reported as published only when TikTok returns a post id. A completed post with no post id is reported as unconfirmed, so no
 * receipt claims a live post that TikTok did not name. Until TikTok approves the app, no receipt from this channel is published.
 */

import { createHash } from "node:crypto";
import { liveTransport, type Transport } from "../providers/http.ts";
import { isTestingRuntimeNow } from "../runtime-mode.ts";
import { hostIsVerified } from "../storage/media-host.ts";
import { TIKTOK_POSTING_SCOPE, TIKTOK_VIDEO_LIST_SCOPE } from "./connection.ts";
import { classifyFailure, failure, parseJsonBody, unconfirmed } from "./graph.ts";
import { readTikTokMetrics } from "./metric-reads.ts";
import type {
  ConnectionCheck,
  DistributionChannel,
  OrganicConnection,
  OrganicMetricsReading,
  OrganicPublishRequest,
  OrganicPublishReceipt,
} from "./types.ts";

const LABEL = "TikTok";
const INIT_URL = "https://open.tiktokapis.com/v2/post/publish/video/init/";
const STATUS_URL = "https://open.tiktokapis.com/v2/post/publish/status/fetch/";
const MAX_CAPTION = 2200;
const VIDEO_TYPES = ["video/mp4", "video/quicktime"];
/** The state in which TikTok is still downloading the video from the link. Any other state is reported as it is. */
const PROCESSING_STATES = new Set(["PROCESSING_DOWNLOAD"]);
/** fail_reason values the documentation marks as safe to retry. */
const RETRYABLE_FAIL_REASONS = new Set(["internal", "video_pull_failed", "photo_pull_failed"]);
const DEFAULT_POLLS = 12;
const POLL_INTERVAL_MS = 5_000;
const NOT_CONNECTED_REASON =
  `No TikTok account is connected for this brand. Connect it in Accounts with a token that grants ${TIKTOK_POSTING_SCOPE}.`;
const NO_MEDIA_LINK_REASON =
  "No signed media link was made for this video, so nothing was sent. Check MEDIA_LINK_SECRET and the public origin on the server.";
const DOMAIN_NOT_VERIFIED_REASON =
  "The media host is not in TIKTOK_VERIFIED_MEDIA_DOMAINS, so TikTok would refuse the pull. Nothing was sent.";

type TiktokBody = { data?: Record<string, unknown>; error?: { code?: string; message?: string } };

export type TikTokDeps = {
  transport: Transport;
  sleep: (ms: number) => Promise<void>;
  /** How many status checks run while TikTok is still downloading the video. */
  polls: number;
};

type StatusReading = { status: string; postId: string; failReason: string };

/** Starts a private post that TikTok pulls from the signed link, then reads its status. */
export async function publishTikTokPull(
  deps: TikTokDeps,
  input: { accessToken: string; mediaUrl: string; caption: string },
): Promise<OrganicPublishReceipt> {
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
        source_info: { source: "PULL_FROM_URL", video_url: input.mediaUrl },
      }),
    });
  } catch {
    // The request may have reached TikTok, so the post is unconfirmed rather than failed.
    return failure("tiktok", "UNCONFIRMED", unconfirmed(LABEL, "no response arrived"));
  }
  const initJson = parseJsonBody(init.body) as TiktokBody | null;
  if (init.status < 200 || init.status >= 300) return refusal(init.status, initJson);

  const publishId = typeof initJson?.data?.publish_id === "string" ? initJson.data.publish_id : "";
  if (!publishId) return failure("tiktok", "UNCONFIRMED", unconfirmed(LABEL, "no publish id was returned"));
  return settlePublish(deps, authorization, publishId);
}

/** A refused init. TikTok's own error codes are read first, then the HTTP status decides, as for the other channels. */
function refusal(status: number, json: TiktokBody | null): OrganicPublishReceipt {
  switch (json?.error?.code) {
    case "url_ownership_unverified":
      return failure("tiktok", "REJECTED", "TikTok has not verified the domain of the media link for this app, so it refused the pull. Nothing was published. Verify the domain in the TikTok developer portal and list it in TIKTOK_VERIFIED_MEDIA_DOMAINS.");
    case "unaudited_client_can_only_post_to_private_accounts":
      return failure("tiktok", "REJECTED", "This TikTok app is not audited, so TikTok accepts private posts only. Nothing was published.");
    case "privacy_level_option_mismatch":
      return failure("tiktok", "REJECTED", "TikTok did not accept the privacy setting for this account. Nothing was published.");
    case "rate_limit_exceeded":
      return failure("tiktok", "RETRYABLE", "TikTok is rate limiting this account. Nothing was confirmed. Try again later.");
    case "access_token_invalid":
    case "scope_not_authorized":
      return failure("tiktok", "AUTH_FAILED", `TikTok refused the saved access token (${json?.error?.code}). Save a current token that grants ${TIKTOK_POSTING_SCOPE} in Accounts. Nothing was published.`);
    default: {
      // No pull has started, so a server error here is safe to retry later.
      const refused = classifyFailure({ label: LABEL, response: { status }, json, uploadStarted: false });
      return failure("tiktok", refused.code, refused.error);
    }
  }
}

/**
 * Checks the status until TikTok stops downloading the video, then reports the last state it gave. A state other than downloading
 * is not checked again, so an inbox delivery or a failure is reported as TikTok states it.
 */
async function settlePublish(deps: TikTokDeps, authorization: string, publishId: string): Promise<OrganicPublishReceipt> {
  let reading = await readStatus(deps.transport, authorization, publishId);
  for (let check = 1; check < deps.polls && reading && PROCESSING_STATES.has(reading.status); check += 1) {
    await deps.sleep(POLL_INTERVAL_MS);
    reading = await readStatus(deps.transport, authorization, publishId);
  }
  return statusReceipt(reading);
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
  const json = parseJsonBody(response.body) as TiktokBody | null;
  const status = typeof json?.data?.status === "string" ? json.data.status : "";
  if (!status) return null;
  const ids = json?.data?.publicaly_available_post_id;
  const postId = Array.isArray(ids) && ids[0] != null ? String(ids[0]) : "";
  const failReason = typeof json?.data?.fail_reason === "string" ? json.data.fail_reason : "";
  return { status, postId, failReason };
}

/**
 * Only PUBLISH_COMPLETE with a post id from TikTok is a published post. Every other state is reported as unconfirmed or failed,
 * and never as published.
 */
function statusReceipt(reading: StatusReading | null): OrganicPublishReceipt {
  if (!reading) return failure("tiktok", "UNCONFIRMED", unconfirmed(LABEL, "the status check did not return a state"));
  if (reading.status === "PUBLISH_COMPLETE") {
    if (!reading.postId) {
      return failure("tiktok", "UNCONFIRMED", unconfirmed(LABEL, "TikTok reports the post complete but returned no post id, which it does for private posts"));
    }
    return { externalId: reading.postId, platform: "tiktok", status: "published", publishedAt: new Date().toISOString() };
  }
  if (reading.status === "FAILED") {
    const reason = reading.failReason ? ` (${reading.failReason})` : "";
    if (reading.failReason === "auth_removed") {
      return failure("tiktok", "AUTH_FAILED", `TikTok removed the account's authorisation, so it could not post this video${reason}. Save a current token in Accounts.`);
    }
    if (RETRYABLE_FAIL_REASONS.has(reading.failReason)) {
      return failure("tiktok", "RETRYABLE", `TikTok could not post this video${reason}. Nothing was published. Try again later.`);
    }
    return failure("tiktok", "REJECTED", `TikTok could not post this video${reason}. Nothing was published.`);
  }
  if (reading.status === "SEND_TO_USER_INBOX") {
    return failure("tiktok", "UNCONFIRMED", unconfirmed(LABEL, "TikTok sent the video to the creator's inbox to finish, so it is not posted yet"));
  }
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
    // The link is checked before any request. TikTok pulls only from a verified domain, and a link on another host is refused here.
    if (!request.mediaUrl) return failure("tiktok", "NOT_CONNECTED", NO_MEDIA_LINK_REASON);
    if (!hostIsVerified(request.mediaUrl, request.verifiedMediaDomains ?? [])) {
      return failure("tiktok", "NOT_CONNECTED", DOMAIN_NOT_VERIFIED_REASON);
    }

    return publishTikTokPull(this.deps, {
      accessToken: connection.accessToken,
      mediaUrl: request.mediaUrl,
      caption: request.caption,
    });
  }

  /** Reads the counts of a post through the video query. A token that declares no video.list scope is not connected for reads. */
  async fetchMetrics(externalId: string, connection: OrganicConnection | undefined): Promise<OrganicMetricsReading> {
    if (!connection?.connected) {
      return { status: "not_connected", reason: this.checkConnection(connection).reason ?? NOT_CONNECTED_REASON };
    }
    if (connection.scopes && !connection.scopes.includes(TIKTOK_VIDEO_LIST_SCOPE)) {
      return {
        status: "not_connected",
        reason: `The saved TikTok token does not grant ${TIKTOK_VIDEO_LIST_SCOPE}, so no metric was requested. Save a token that grants it in Accounts.`,
      };
    }
    return readTikTokMetrics(this.deps.transport, { externalId, accessToken: connection.accessToken }, new Date());
  }
}
