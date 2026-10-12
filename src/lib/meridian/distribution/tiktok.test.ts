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
const UPLOAD_URL = "https://upload.example.test/tiktok/chunk";

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
    ...overrides,
  };
}

const noSleep = async () => undefined;
const initReply = reply(200, { data: { publish_id: "pub-1", upload_url: UPLOAD_URL }, error: { code: "ok", message: "" } });
const uploadReply = reply(201, "");

function statusReply(status: string, extra: Record<string, unknown> = {}): TransportResponse {
  return reply(200, { data: { status, ...extra }, error: { code: "ok", message: "" } });
}

test("TikTok without a connection sends nothing and reports NOT_CONNECTED with the reason", async () => {
  const { transport, requests } = scripted([]);
  const receipt = await new TikTokOrganicChannel({ transport, sleep: noSleep }).publish(request());
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.code, "NOT_CONNECTED");
  assert.equal(receipt.externalId, "");
  assert.match(receipt.error ?? "", /video\.publish/);
  assert.equal(requests.length, 0);
});

test("TikTok refuses a token that does not grant video.publish, and sends nothing", async () => {
  const { transport, requests } = scripted([]);
  const receipt = await new TikTokOrganicChannel({ transport, sleep: noSleep }).publish(request({ connection: connected(["user.info.basic"]) }));
  assert.equal(receipt.code, "NOT_CONNECTED");
  assert.match(receipt.error ?? "", /Reconnect the account/);
  assert.equal(requests.length, 0);
});

test("TikTok refuses a file that is not MP4 or MOV, and sends nothing", async () => {
  const { transport, requests } = scripted([]);
  const receipt = await new TikTokOrganicChannel({ transport, sleep: noSleep }).publish(request({ connection: connected(), mimeType: "image/png" }));
  assert.equal(receipt.code, "REJECTED");
  assert.match(receipt.error ?? "", /MP4 or MOV/);
  assert.equal(requests.length, 0);
});

test("TikTok refuses an empty file and a schedule, and sends nothing", async () => {
  const { transport, requests } = scripted([]);
  const empty = await new TikTokOrganicChannel({ transport, sleep: noSleep }).publish(request({ connection: connected(), mediaBytes: new Uint8Array(0) }));
  assert.equal(empty.code, "REJECTED");
  const scheduled = await new TikTokOrganicChannel({ transport, sleep: noSleep }).publish(
    request({ connection: connected(), scheduledFor: new Date(Date.now() + 3_600_000).toISOString() }),
  );
  assert.equal(scheduled.code, "REJECTED");
  assert.match(scheduled.error ?? "", /cannot be scheduled/);
  assert.equal(requests.length, 0);
});

test("TikTok refuses a video over 64 MB before it sends anything", async () => {
  const { transport, requests } = scripted([]);
  const receipt = await new TikTokOrganicChannel({ transport, sleep: noSleep }).publish(
    request({ connection: connected(), mediaBytes: new Uint8Array(64 * 1024 * 1024 + 1) }),
  );
  assert.equal(receipt.code, "REJECTED");
  assert.equal(requests.length, 0);
});

test("TikTok starts a private upload, sends the bytes in one chunk, and reports published once TikTok completes the post", async () => {
  const { transport, requests } = scripted([
    initReply,
    uploadReply,
    statusReply("PUBLISH_COMPLETE", { publicaly_available_post_id: ["7001"] }),
  ]);
  const receipt = await new TikTokOrganicChannel({ transport, sleep: noSleep }).publish(request({ connection: connected(), caption: "Launch video" }));
  assert.equal(receipt.status, "published");
  assert.equal(receipt.externalId, "7001");
  assert.equal(receipt.platform, "tiktok");
  assert.ok(receipt.publishedAt);
  assert.equal(requests.length, 3);

  const init = requests[0]!;
  assert.equal(init.method, "POST");
  assert.equal(init.url, INIT_URL);
  assert.equal(init.headers.Authorization, "Bearer token-123");
  const initBody = JSON.parse(String(init.body)) as { post_info: { title: string; privacy_level: string }; source_info: Record<string, unknown> };
  assert.equal(initBody.post_info.privacy_level, "SELF_ONLY", "posts stay private until the app is approved for public posting");
  assert.equal(initBody.post_info.title, "Launch video");
  assert.deepEqual(initBody.source_info, { source: "FILE_UPLOAD", video_size: 4, chunk_size: 4, total_chunk_count: 1 });

  const upload = requests[1]!;
  assert.equal(upload.method, "PUT");
  assert.equal(upload.url, UPLOAD_URL);
  assert.equal(upload.headers["Content-Type"], "video/mp4");
  assert.equal(upload.headers["Content-Range"], "bytes 0-3/4");
  assert.ok(upload.body instanceof Uint8Array);

  const status = requests[2]!;
  assert.equal(status.method, "POST");
  assert.equal(status.url, STATUS_URL);
  assert.equal(JSON.parse(String(status.body)).publish_id, "pub-1");
});

test("TikTok names the publish id when TikTok returns no public post id", async () => {
  const { transport } = scripted([initReply, uploadReply, statusReply("PUBLISH_COMPLETE")]);
  const receipt = await new TikTokOrganicChannel({ transport, sleep: noSleep }).publish(request({ connection: connected() }));
  assert.equal(receipt.status, "published");
  assert.equal(receipt.externalId, "pub-1");
});

test("TikTok keeps checking while it processes the upload, then reports the state it settles on", async () => {
  const waited: number[] = [];
  const { transport, requests } = scripted([initReply, uploadReply, statusReply("PROCESSING_UPLOAD"), statusReply("PUBLISH_COMPLETE")]);
  const receipt = await new TikTokOrganicChannel({
    transport,
    sleep: async (ms) => { waited.push(ms); },
    polls: 5,
  }).publish(request({ connection: connected() }));
  assert.equal(receipt.status, "published");
  assert.equal(requests.length, 4);
  assert.deepEqual(waited, [5_000], "one wait between the two status checks");
});

test("TikTok stops checking after its last poll and reports the processing state as unconfirmed", async () => {
  const { transport, requests } = scripted([
    initReply,
    uploadReply,
    statusReply("PROCESSING_DOWNLOAD"),
    statusReply("PROCESSING_DOWNLOAD"),
    statusReply("PROCESSING_DOWNLOAD"),
  ]);
  const receipt = await new TikTokOrganicChannel({ transport, sleep: noSleep, polls: 3 }).publish(request({ connection: connected() }));
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.code, "UNCONFIRMED");
  assert.equal(receipt.externalId, "");
  assert.match(receipt.error ?? "", /processing download/);
  assert.equal(requests.length, 5, "three status checks after the upload, and no more");
});

test("TikTok does not check again when the upload went to the user's inbox, and does not report it as published", async () => {
  const { transport, requests } = scripted([initReply, uploadReply, statusReply("SEND_TO_USER_INBOX")]);
  const receipt = await new TikTokOrganicChannel({ transport, sleep: noSleep, polls: 5 }).publish(request({ connection: connected() }));
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.code, "UNCONFIRMED");
  assert.match(receipt.error ?? "", /send to user inbox/);
  assert.equal(requests.length, 3);
});

test("TikTok reports a post that TikTok failed as rejected", async () => {
  const { transport } = scripted([initReply, uploadReply, statusReply("FAILED", { fail_reason: "video_format" })]);
  const receipt = await new TikTokOrganicChannel({ transport, sleep: noSleep }).publish(request({ connection: connected() }));
  assert.equal(receipt.code, "REJECTED");
  assert.equal(receipt.externalId, "");
  assert.equal(receipt.error, "TikTok could not post this video.");
});

test("TikTok maps a refused init to an auth failure, and nothing is uploaded", async () => {
  const { transport, requests } = scripted([reply(401, { error: { code: "access_token_invalid", message: "Access token is invalid." } })]);
  const receipt = await new TikTokOrganicChannel({ transport, sleep: noSleep }).publish(request({ connection: connected() }));
  assert.equal(receipt.code, "AUTH_FAILED");
  assert.equal(receipt.externalId, "");
  assert.equal(requests.length, 1);
});

test("TikTok is retryable when the init is rate limited or unavailable, since no bytes were sent", async () => {
  const limited = scripted([reply(429, { error: { code: "rate_limit_exceeded", message: "Too many requests" } })]);
  const first = await new TikTokOrganicChannel({ transport: limited.transport, sleep: noSleep }).publish(request({ connection: connected() }));
  assert.equal(first.code, "RETRYABLE");
  assert.equal(limited.requests.length, 1);

  const unavailable = scripted([reply(503, "")]);
  const second = await new TikTokOrganicChannel({ transport: unavailable.transport, sleep: noSleep }).publish(request({ connection: connected() }));
  assert.equal(second.code, "RETRYABLE");
  assert.equal(unavailable.requests.length, 1);
});

test("TikTok with no publish id or upload address is unconfirmed, and sends no bytes", async () => {
  const { transport, requests } = scripted([reply(200, { data: {}, error: { code: "ok", message: "" } })]);
  const receipt = await new TikTokOrganicChannel({ transport, sleep: noSleep }).publish(request({ connection: connected() }));
  assert.equal(receipt.code, "UNCONFIRMED");
  assert.equal(requests.length, 1);
});

test("TikTok does not report a post after a failed byte upload, and does not check its status", async () => {
  const { transport, requests } = scripted([initReply, reply(500, "")]);
  const receipt = await new TikTokOrganicChannel({ transport, sleep: noSleep }).publish(request({ connection: connected() }));
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.code, "UNCONFIRMED");
  assert.equal(receipt.externalId, "");
  assert.equal(requests.length, 2);
});

test("TikTok reports a dropped connection on the init as unconfirmed", async () => {
  const { transport } = scripted([new Error("socket hang up")]);
  const receipt = await new TikTokOrganicChannel({ transport, sleep: noSleep }).publish(request({ connection: connected() }));
  assert.equal(receipt.code, "UNCONFIRMED");
});

test("TikTok reports a status check that gets no answer, or no state, as unconfirmed and never as published", async () => {
  const dropped = scripted([initReply, uploadReply, new Error("reset")]);
  const droppedReceipt = await new TikTokOrganicChannel({ transport: dropped.transport, sleep: noSleep }).publish(request({ connection: connected() }));
  assert.equal(droppedReceipt.status, "failed");
  assert.equal(droppedReceipt.code, "UNCONFIRMED");
  assert.match(droppedReceipt.error ?? "", /did not return a state/);

  const noState = scripted([initReply, uploadReply, reply(401, { error: { code: "access_token_invalid", message: "expired" } })]);
  const noStateReceipt = await new TikTokOrganicChannel({ transport: noState.transport, sleep: noSleep }).publish(request({ connection: connected() }));
  assert.equal(noStateReceipt.status, "failed");
  assert.equal(noStateReceipt.code, "UNCONFIRMED");
});

test("TikTok does not invent live metrics", async () => {
  const { transport } = scripted([]);
  assert.equal(await new TikTokOrganicChannel({ transport, sleep: noSleep }).fetchMetrics("7001"), null);
});

test("TikTok is registered as an organic channel for the publish service", () => {
  const channel = getDistributionChannel("tiktok-organic");
  assert.ok(channel instanceof TikTokOrganicChannel);
  assert.equal(channel?.platform, "tiktok");
  assert.equal(channel?.targetType, "organic_post");
});
