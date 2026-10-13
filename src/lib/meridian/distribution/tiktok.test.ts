import assert from "node:assert/strict";
import test from "node:test";
import type { Transport, TransportRequest, TransportResponse } from "../providers/http.ts";
import { getDistributionChannel } from "./registry.ts";
import { TikTokOrganicChannel } from "./tiktok.ts";
import type { OrganicConnection, OrganicPublishRequest } from "./types.ts";

// Receipts here come only from the injected transport. The testing-runtime receipt is not in play.
process.env.NODE_ENV = "development";
delete process.env.MERIDIAN_TESTING_RUNTIME;

const INIT_URL = "https://open.tiktokapis.com/v2/post/publish/video/init/";
const STATUS_URL = "https://open.tiktokapis.com/v2/post/publish/status/fetch/";
const VERIFIED = ["media.example.test"];
const SIGNED_LINK = `https://media.example.test/api/media-links/cr-1?expires=1900000000&sig=${"b".repeat(64)}`;

function reply(status: number, body: unknown = {}): TransportResponse {
  return { status, body: typeof body === "string" ? body : JSON.stringify(body), headers: {} };
}

/** Replies in order. A request past the end of the list fails the test, so an extra request is caught. */
function scripted(replies: Array<TransportResponse | Error>) {
  const requests: TransportRequest[] = [];
  let next = 0;
  const transport: Transport = async (request) => {
    requests.push(request);
    const entry = replies[next];
    next += 1;
    if (!entry) throw new Error(`unexpected request ${request.method} ${request.url}`);
    if (entry instanceof Error) throw entry;
    return entry;
  };
  return { transport, requests };
}

function connected(scopes: string[] | null = ["video.publish"]): OrganicConnection {
  return { connected: true, platform: "tiktok", accountId: "open-id-1", accountName: "Brand", accessToken: "token-123", scopes };
}

function request(overrides: Partial<OrganicPublishRequest> = {}): OrganicPublishRequest {
  return {
    brandId: "brand-1",
    organizationId: "org-1",
    mediaBytes: new Uint8Array([1, 2, 3, 4]),
    mimeType: "video/mp4",
    caption: "Caption",
    aspectRatio: "9:16",
    connection: connected(),
    mediaUrl: SIGNED_LINK,
    verifiedMediaDomains: VERIFIED,
    ...overrides,
  };
}

const noSleep = async () => undefined;
const initReply = reply(200, { data: { publish_id: "pub-1" }, error: { code: "ok", message: "" } });

function statusReply(status: string, extra: Record<string, unknown> = {}): TransportResponse {
  return reply(200, { data: { status, ...extra }, error: { code: "ok", message: "" } });
}

function channel(replies: Array<TransportResponse | Error>, polls = 3) {
  const { transport, requests } = scripted(replies);
  return { requests, channel: new TikTokOrganicChannel({ transport, sleep: noSleep, polls }) };
}

// ---- Refusals before any request ----

test("TikTok without a connection sends nothing and reports NOT_CONNECTED with the reason", async () => {
  const { requests, channel: tiktok } = channel([]);
  const receipt = await tiktok.publish(request({ connection: undefined }));
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.code, "NOT_CONNECTED");
  assert.match(receipt.error ?? "", /No TikTok account is connected/);
  assert.equal(requests.length, 0);
});

test("TikTok refuses a token that does not grant video.publish, and sends nothing", async () => {
  const { requests, channel: tiktok } = channel([]);
  const receipt = await tiktok.publish(request({ connection: connected(["user.info.basic"]) }));
  assert.equal(receipt.code, "NOT_CONNECTED");
  assert.equal(requests.length, 0);
});

test("TikTok refuses a file that is not MP4 or MOV, and sends nothing", async () => {
  const { requests, channel: tiktok } = channel([]);
  const receipt = await tiktok.publish(request({ mimeType: "image/png" }));
  assert.equal(receipt.code, "REJECTED");
  assert.equal(requests.length, 0);
});

test("TikTok refuses an empty file and a schedule, and sends nothing", async () => {
  const { requests, channel: tiktok } = channel([]);
  assert.equal((await tiktok.publish(request({ mediaBytes: new Uint8Array() }))).code, "REJECTED");
  assert.equal((await tiktok.publish(request({ scheduledFor: new Date(Date.now() + 3_600_000).toISOString() }))).code, "REJECTED");
  assert.equal(requests.length, 0);
});

test("TikTok without a signed media link reports NOT_CONNECTED and sends nothing", async () => {
  const { requests, channel: tiktok } = channel([]);
  const receipt = await tiktok.publish(request({ mediaUrl: undefined }));
  assert.equal(receipt.code, "NOT_CONNECTED");
  assert.match(receipt.error ?? "", /signed media link/);
  assert.equal(requests.length, 0);
});

test("TikTok refuses a media host that is not a verified domain, before any request is made", async () => {
  const { requests, channel: tiktok } = channel([]);
  const receipt = await tiktok.publish(request({ verifiedMediaDomains: ["other.example.test"] }));
  assert.equal(receipt.code, "NOT_CONNECTED");
  assert.match(receipt.error ?? "", /TIKTOK_VERIFIED_MEDIA_DOMAINS/);
  assert.equal(requests.length, 0, "no request reaches TikTok for an unverified domain");
});

test("TikTok refuses a link that is not https, even on a verified host", async () => {
  const { requests, channel: tiktok } = channel([]);
  const receipt = await tiktok.publish(request({ mediaUrl: SIGNED_LINK.replace("https:", "http:") }));
  assert.equal(receipt.code, "NOT_CONNECTED");
  assert.equal(requests.length, 0);
});

// ---- The pull request and the status ----

test("TikTok starts a private pull from the signed link and reports published only with TikTok's post id", async () => {
  const { requests, channel: tiktok } = channel([initReply, statusReply("PUBLISH_COMPLETE", { publicaly_available_post_id: [7001] })]);
  const receipt = await tiktok.publish(request());
  assert.equal(receipt.status, "published");
  assert.equal(receipt.externalId, "7001", "the receipt id is TikTok's post id");
  assert.equal(receipt.platform, "tiktok");
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.url, INIT_URL);
  assert.equal(requests[0]!.headers.Authorization, "Bearer token-123");
  const body = JSON.parse(String(requests[0]!.body)) as {
    post_info: { privacy_level: string; title: string };
    source_info: { source: string; video_url: string; video_size?: number };
  };
  assert.equal(body.source_info.source, "PULL_FROM_URL");
  assert.equal(body.source_info.video_url, SIGNED_LINK, "the request carries the signed link, not the bytes");
  assert.equal(body.source_info.video_size, undefined, "no upload size is sent for a pull");
  assert.equal(body.post_info.privacy_level, "SELF_ONLY", "an unaudited app posts privately");
  assert.equal(body.post_info.title, "Caption");
  assert.equal(requests[1]!.url, STATUS_URL);
  assert.deepEqual(JSON.parse(String(requests[1]!.body)), { publish_id: "pub-1" });
});

test("TikTok reports PUBLISH_COMPLETE without a post id as unconfirmed, never as published", async () => {
  const { channel: tiktok } = channel([initReply, statusReply("PUBLISH_COMPLETE")]);
  const receipt = await tiktok.publish(request());
  assert.notEqual(receipt.status, "published");
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.code, "UNCONFIRMED");
  assert.equal(receipt.externalId, "", "the publish id is never used as the post id");
  assert.match(receipt.error ?? "", /no post id/);
});

test("TikTok keeps checking while it downloads the video, then reports the state it settles on", async () => {
  const { channel: tiktok } = channel([
    initReply,
    statusReply("PROCESSING_DOWNLOAD"),
    statusReply("PROCESSING_DOWNLOAD"),
    statusReply("PUBLISH_COMPLETE", { publicaly_available_post_id: ["7002"] }),
  ]);
  const receipt = await tiktok.publish(request());
  assert.equal(receipt.status, "published");
  assert.equal(receipt.externalId, "7002");
});

test("TikTok stops checking after its last poll and reports the downloading state as unconfirmed", async () => {
  const { channel: tiktok } = channel([initReply, statusReply("PROCESSING_DOWNLOAD"), statusReply("PROCESSING_DOWNLOAD"), statusReply("PROCESSING_DOWNLOAD")], 3);
  const receipt = await tiktok.publish(request());
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.code, "UNCONFIRMED");
  assert.equal(receipt.externalId, "");
});

test("TikTok does not check again when the video went to the creator's inbox, and does not report it as published", async () => {
  const { requests, channel: tiktok } = channel([initReply, statusReply("SEND_TO_USER_INBOX")]);
  const receipt = await tiktok.publish(request());
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.code, "UNCONFIRMED");
  assert.equal(requests.length, 2);
});

test("TikTok reports a FAILED post with the retry rule its fail_reason names", async () => {
  const retry = await channel([initReply, statusReply("FAILED", { fail_reason: "video_pull_failed" })]).channel.publish(request());
  assert.equal(retry.code, "RETRYABLE");
  const rejected = await channel([initReply, statusReply("FAILED", { fail_reason: "spam_risk" })]).channel.publish(request());
  assert.equal(rejected.code, "REJECTED");
  const auth = await channel([initReply, statusReply("FAILED", { fail_reason: "auth_removed" })]).channel.publish(request());
  assert.equal(auth.code, "AUTH_FAILED");
  for (const receipt of [retry, rejected, auth]) assert.equal(receipt.status, "failed");
});

test("TikTok reports a status check that gets no answer, or no state, as unconfirmed and never as published", async () => {
  const dropped = await channel([initReply, new Error("socket hang up")]).channel.publish(request());
  assert.equal(dropped.code, "UNCONFIRMED");
  assert.notEqual(dropped.status, "published");
  const empty = await channel([initReply, reply(200, { data: {}, error: { code: "ok", message: "" } })]).channel.publish(request());
  assert.equal(empty.code, "UNCONFIRMED");
});

// ---- Refused init, by TikTok's own error codes ----

test("TikTok refuses an unverified URL domain at init, and does not check a status", async () => {
  const { requests, channel: tiktok } = channel([reply(403, { error: { code: "url_ownership_unverified", message: "" } })]);
  const receipt = await tiktok.publish(request());
  assert.equal(receipt.code, "REJECTED");
  assert.match(receipt.error ?? "", /not verified the domain/);
  assert.equal(requests.length, 1);
});

test("TikTok names the private-only rule for an unaudited app, and is refused, not retried", async () => {
  const { channel: tiktok } = channel([reply(403, { error: { code: "unaudited_client_can_only_post_to_private_accounts", message: "" } })]);
  const receipt = await tiktok.publish(request());
  assert.equal(receipt.code, "REJECTED");
  assert.match(receipt.error ?? "", /private posts only/);
});

test("TikTok maps an invalid token at init to an auth failure", async () => {
  const { channel: tiktok } = channel([reply(401, { error: { code: "access_token_invalid", message: "" } })]);
  const receipt = await tiktok.publish(request());
  assert.equal(receipt.code, "AUTH_FAILED");
  assert.equal(receipt.externalId, "");
});

test("TikTok is retryable when the init is rate limited, since no pull started", async () => {
  const { channel: tiktok } = channel([reply(429, { error: { code: "rate_limit_exceeded", message: "" } })]);
  assert.equal((await tiktok.publish(request())).code, "RETRYABLE");
});

test("TikTok is retryable on a 500 at init, since no pull started", async () => {
  const { channel: tiktok } = channel([reply(500, { error: { code: "internal_error", message: "" } })]);
  assert.equal((await tiktok.publish(request())).code, "RETRYABLE");
});

test("TikTok reports a dropped connection on the init as unconfirmed", async () => {
  const { channel: tiktok } = channel([new Error("reset")]);
  const receipt = await tiktok.publish(request());
  assert.equal(receipt.code, "UNCONFIRMED");
  assert.notEqual(receipt.status, "published");
});

test("TikTok with no publish id in the init response is unconfirmed, and checks no status", async () => {
  const { requests, channel: tiktok } = channel([reply(200, { data: {}, error: { code: "ok", message: "" } })]);
  const receipt = await tiktok.publish(request());
  assert.equal(receipt.code, "UNCONFIRMED");
  assert.equal(requests.length, 1);
});

test("TikTok does not invent live metrics", async () => {
  const { channel: tiktok } = channel([]);
  assert.equal(await tiktok.fetchMetrics("7001"), null);
});

test("TikTok is registered as an organic channel for the publish service", () => {
  const channelRegistered = getDistributionChannel("tiktok-organic");
  assert.ok(channelRegistered instanceof TikTokOrganicChannel);
  assert.equal(channelRegistered?.platform, "tiktok");
  assert.equal(channelRegistered?.targetType, "organic_post");
});
