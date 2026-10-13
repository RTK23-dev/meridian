import assert from "node:assert/strict";
import test from "node:test";
import type { Transport, TransportRequest, TransportResponse } from "../providers/http.ts";
import { FacebookPagesChannel } from "./facebook.ts";
import { InstagramReelsChannel } from "./instagram.ts";
import { YouTubeShortsChannel } from "./youtube.ts";
import type { OrganicConnection, OrganicPlatform, OrganicPublishRequest } from "./types.ts";

// Receipts here come only from the injected transport. The testing-runtime receipt is not in play.
process.env.NODE_ENV = "development";
delete process.env.MERIDIAN_TESTING_RUNTIME;

function reply(status: number, body: unknown = {}, headers: Record<string, string> = {}): TransportResponse {
  return { status, body: typeof body === "string" ? body : JSON.stringify(body), headers };
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

function connected(platform: OrganicPlatform, accountId: string): OrganicConnection {
  return { connected: true, platform, accountId, accountName: "Brand", accessToken: "token-123", scopes: null };
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

// ---- Facebook Page video ----

test("Facebook without a connection sends nothing and reports NOT_CONNECTED with the reason", async () => {
  const { transport, requests } = scripted([]);
  const receipt = await new FacebookPagesChannel({ transport }).publish(request());
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.code, "NOT_CONNECTED");
  assert.equal(receipt.externalId, "");
  assert.match(receipt.error ?? "", /Page ID and a Page access token/);
  assert.equal(requests.length, 0);
});

test("Facebook uploads the video to the Page's videos edge and returns the id from the response", async () => {
  const { transport, requests } = scripted([reply(200, { id: "vid-42" })]);
  const receipt = await new FacebookPagesChannel({ transport }).publish(
    request({ connection: connected("facebook", "page-9"), title: "Launch" }),
  );
  assert.equal(receipt.status, "published");
  assert.equal(receipt.externalId, "vid-42");
  assert.equal(receipt.platform, "facebook");
  assert.equal(receipt.postUrl, "https://www.facebook.com/page-9/videos/vid-42/");
  assert.equal(requests.length, 1);
  const sent = requests[0]!;
  assert.equal(sent.method, "POST");
  assert.equal(sent.url, "https://graph.facebook.com/v21.0/page-9/videos");
  assert.equal(sent.headers.Authorization, "Bearer token-123");
  const body = sent.body as FormData;
  assert.ok(body instanceof FormData);
  assert.equal(body.get("description"), "Caption");
  assert.equal(body.get("title"), "Launch");
  assert.ok(body.get("source") instanceof Blob);
  assert.equal(body.get("published"), null, "an immediate post does not send the unpublished flag");
});

test("Facebook schedules when a time is given, and the receipt is scheduled with the response id", async () => {
  const when = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const { transport, requests } = scripted([reply(200, { id: "vid-77" })]);
  const receipt = await new FacebookPagesChannel({ transport }).publish(
    request({ connection: connected("facebook", "page-9"), scheduledFor: when.toISOString() }),
  );
  assert.equal(receipt.status, "scheduled");
  assert.equal(receipt.externalId, "vid-77");
  const body = requests[0]!.body as FormData;
  assert.equal(body.get("published"), "false");
  assert.equal(body.get("scheduled_publish_time"), String(Math.floor(when.getTime() / 1000)));
});

test("Facebook refuses a schedule that is too close or too far, and sends nothing", async () => {
  const { transport, requests } = scripted([]);
  const soon = await new FacebookPagesChannel({ transport }).publish(
    request({ connection: connected("facebook", "page-9"), scheduledFor: new Date(Date.now() + 60_000).toISOString() }),
  );
  assert.equal(soon.code, "REJECTED");
  assert.match(soon.error ?? "", /10 minutes to 75 days/);
  assert.equal(requests.length, 0);
});

test("Facebook refuses a non-video file before it sends anything", async () => {
  const { transport, requests } = scripted([]);
  const receipt = await new FacebookPagesChannel({ transport }).publish(
    request({ connection: connected("facebook", "page-9"), mimeType: "image/png" }),
  );
  assert.equal(receipt.code, "REJECTED");
  assert.equal(requests.length, 0);
});

test("Facebook maps 401 to an auth failure with no retry and no receipt id", async () => {
  const { transport, requests } = scripted([reply(401, { error: { message: "Invalid OAuth access token.", code: 190 } })]);
  const receipt = await new FacebookPagesChannel({ transport }).publish(request({ connection: connected("facebook", "page-9") }));
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.code, "AUTH_FAILED");
  assert.equal(receipt.externalId, "");
  assert.equal(receipt.postUrl, undefined);
  assert.equal(requests.length, 1);
});

test("Facebook maps 403 to an auth failure", async () => {
  const { transport } = scripted([reply(403, { error: { message: "Permissions error", code: 200 } })]);
  const receipt = await new FacebookPagesChannel({ transport }).publish(request({ connection: connected("facebook", "page-9") }));
  assert.equal(receipt.code, "AUTH_FAILED");
});

test("Facebook maps a 429 and a Graph rate-limit code to a retryable failure, with no retry of its own", async () => {
  const byStatus = scripted([reply(429, { error: { message: "Too many calls", code: 4 } })]);
  const first = await new FacebookPagesChannel({ transport: byStatus.transport }).publish(request({ connection: connected("facebook", "page-9") }));
  assert.equal(first.code, "RETRYABLE");
  assert.equal(byStatus.requests.length, 1);

  const byCode = scripted([reply(400, { error: { message: "Application request limit reached", code: 4 } })]);
  const second = await new FacebookPagesChannel({ transport: byCode.transport }).publish(request({ connection: connected("facebook", "page-9") }));
  assert.equal(second.code, "RETRYABLE");
  assert.equal(byCode.requests.length, 1);
});

test("Facebook does not report a publish after a 500, because the post may have been accepted", async () => {
  const { transport, requests } = scripted([reply(500, { error: { message: "internal" } })]);
  const receipt = await new FacebookPagesChannel({ transport }).publish(request({ connection: connected("facebook", "page-9") }));
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.code, "UNCONFIRMED");
  assert.equal(receipt.externalId, "");
  assert.equal(requests.length, 1, "a non-idempotent upload is not retried");
});

test("Facebook reports a success response without a video id as unconfirmed, not published", async () => {
  const { transport } = scripted([reply(200, { success: true })]);
  const receipt = await new FacebookPagesChannel({ transport }).publish(request({ connection: connected("facebook", "page-9") }));
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.code, "UNCONFIRMED");
  assert.equal(receipt.externalId, "");
});

test("Facebook reports a dropped connection as unconfirmed", async () => {
  const { transport } = scripted([new Error("socket hang up")]);
  const receipt = await new FacebookPagesChannel({ transport }).publish(request({ connection: connected("facebook", "page-9") }));
  assert.equal(receipt.code, "UNCONFIRMED");
});

test("a provider rejection carries the provider's message, redacted, and is REJECTED", async () => {
  const { transport } = scripted([reply(400, { error: { message: "Unsupported video format" } })]);
  const receipt = await new FacebookPagesChannel({ transport }).publish(request({ connection: connected("facebook", "page-9") }));
  assert.equal(receipt.code, "REJECTED");
  assert.match(receipt.error ?? "", /Unsupported video format/);
});

// ---- Instagram Reels container flow ----

// A signed, short-lived link to an approved creative (storage/media-link.ts). The platform fetches it, so it is the only video reference.
const signedReel = `https://media.example.test/api/media-links/cr-1?expires=1900000000&sig=${"a".repeat(64)}`;

test("Instagram without a connection sends nothing", async () => {
  const { transport, requests } = scripted([]);
  const receipt = await new InstagramReelsChannel({ transport, sleep: noSleep }).publish(request({ mediaUrl: signedReel }));
  assert.equal(receipt.code, "NOT_CONNECTED");
  assert.equal(requests.length, 0);
});

test("Instagram without a signed media link reports NOT_CONNECTED and sends nothing", async () => {
  const { transport, requests } = scripted([]);
  const receipt = await new InstagramReelsChannel({ transport, sleep: noSleep }).publish(request({ connection: connected("instagram", "ig-1") }));
  assert.equal(receipt.code, "NOT_CONNECTED");
  assert.match(receipt.error ?? "", /signed media link/);
  assert.equal(requests.length, 0);
});

test("Instagram refuses a media link that is not https, and sends nothing", async () => {
  const { transport, requests } = scripted([]);
  const receipt = await new InstagramReelsChannel({ transport, sleep: noSleep }).publish(
    request({ connection: connected("instagram", "ig-1"), mediaUrl: "http://media.example.test/x?expires=1&sig=b" }),
  );
  assert.equal(receipt.code, "NOT_CONNECTED");
  assert.equal(requests.length, 0);
});

test("Instagram creates a Reel container, waits until it is finished, then publishes it and returns the media id", async () => {
  const { transport, requests } = scripted([
    reply(200, { id: "container-1" }),
    reply(200, { status_code: "IN_PROGRESS" }),
    reply(200, { status_code: "FINISHED" }),
    reply(200, { id: "media-5" }),
  ]);
  const receipt = await new InstagramReelsChannel({ transport, sleep: noSleep }).publish(
    request({ connection: connected("instagram", "ig-1"), mediaUrl: signedReel }),
  );
  assert.equal(receipt.status, "published");
  assert.equal(receipt.externalId, "media-5");
  assert.equal(receipt.platform, "instagram");
  assert.equal(requests.length, 4);
  assert.equal(requests[0]!.url, "https://graph.facebook.com/v21.0/ig-1/media");
  const containerBody = new URLSearchParams(String(requests[0]!.body));
  assert.equal(containerBody.get("media_type"), "REELS");
  assert.equal(containerBody.get("video_url"), signedReel, "the container fetches the signed link, not the bytes");
  assert.equal(requests[3]!.url, "https://graph.facebook.com/v21.0/ig-1/media_publish");
  assert.equal(new URLSearchParams(String(requests[3]!.body)).get("creation_id"), "container-1");
  assert.ok(requests.every((sent) => sent.headers.Authorization === "Bearer token-123"));
});

test("Instagram stops with an error when the container fails processing, and does not publish", async () => {
  const { transport, requests } = scripted([reply(200, { id: "container-2" }), reply(200, { status_code: "ERROR" })]);
  const receipt = await new InstagramReelsChannel({ transport, sleep: noSleep }).publish(
    request({ connection: connected("instagram", "ig-1"), mediaUrl: signedReel }),
  );
  assert.equal(receipt.code, "REJECTED");
  assert.equal(requests.length, 2);
});

test("Instagram that never finishes processing is retryable and is not published", async () => {
  const { transport, requests } = scripted([
    reply(200, { id: "container-3" }),
    reply(200, { status_code: "IN_PROGRESS" }),
    reply(200, { status_code: "IN_PROGRESS" }),
  ]);
  const receipt = await new InstagramReelsChannel({ transport, sleep: noSleep, polls: 2 }).publish(
    request({ connection: connected("instagram", "ig-1"), mediaUrl: signedReel }),
  );
  assert.equal(receipt.code, "RETRYABLE");
  assert.equal(requests.length, 3);
});

test("Instagram maps a 401 on the container step to an auth failure", async () => {
  const { transport, requests } = scripted([reply(401, { error: { message: "Invalid token", code: 190 } })]);
  const receipt = await new InstagramReelsChannel({ transport, sleep: noSleep }).publish(
    request({ connection: connected("instagram", "ig-1"), mediaUrl: signedReel }),
  );
  assert.equal(receipt.code, "AUTH_FAILED");
  assert.equal(requests.length, 1);
});

test("Instagram does not report a publish after a 500 on the publish step", async () => {
  const { transport } = scripted([
    reply(200, { id: "container-4" }),
    reply(200, { status_code: "FINISHED" }),
    reply(500, { error: { message: "internal" } }),
  ]);
  const receipt = await new InstagramReelsChannel({ transport, sleep: noSleep }).publish(
    request({ connection: connected("instagram", "ig-1"), mediaUrl: signedReel }),
  );
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.code, "UNCONFIRMED");
  assert.equal(receipt.externalId, "");
});

test("Instagram refuses a schedule, since this channel does not schedule Reels", async () => {
  const { transport, requests } = scripted([]);
  const receipt = await new InstagramReelsChannel({ transport, sleep: noSleep }).publish(
    request({ connection: connected("instagram", "ig-1"), mediaUrl: signedReel, scheduledFor: new Date(Date.now() + 3_600_000).toISOString() }),
  );
  assert.equal(receipt.code, "REJECTED");
  assert.equal(requests.length, 0);
});

// ---- YouTube Shorts resumable upload ----

test("YouTube without a connection sends nothing", async () => {
  const { transport, requests } = scripted([]);
  const receipt = await new YouTubeShortsChannel({ transport }).publish(request());
  assert.equal(receipt.code, "NOT_CONNECTED");
  assert.equal(requests.length, 0);
});

test("YouTube opens a resumable session, sends the bytes to it, and returns the video id from the response", async () => {
  const sessionUrl = "https://upload.example.test/session/abc";
  const { transport, requests } = scripted([
    reply(200, "", { location: sessionUrl }),
    reply(200, { id: "yt-7" }),
  ]);
  const receipt = await new YouTubeShortsChannel({ transport }).publish(
    request({ connection: connected("youtube", "channel-1"), title: "Launch short" }),
  );
  assert.equal(receipt.status, "published");
  assert.equal(receipt.externalId, "yt-7");
  assert.equal(receipt.postUrl, "https://www.youtube.com/shorts/yt-7");
  assert.equal(requests.length, 2);
  const init = requests[0]!;
  assert.equal(init.method, "POST");
  assert.match(init.url, /uploadType=resumable/);
  assert.equal(init.headers.Authorization, "Bearer token-123");
  assert.equal(init.headers["X-Upload-Content-Length"], "4");
  assert.equal(init.headers["X-Upload-Content-Type"], "video/mp4");
  const metadata = JSON.parse(String(init.body)) as { snippet: { title: string }; status: { privacyStatus: string } };
  assert.equal(metadata.snippet.title, "Launch short");
  assert.equal(metadata.status.privacyStatus, "public");
  const upload = requests[1]!;
  assert.equal(upload.method, "PUT");
  assert.equal(upload.url, sessionUrl);
  assert.ok(upload.body instanceof Uint8Array);
});

test("YouTube maps a refused session to an auth failure, and nothing is uploaded", async () => {
  const { transport, requests } = scripted([reply(403, { error: { message: "Insufficient Permission" } })]);
  const receipt = await new YouTubeShortsChannel({ transport }).publish(request({ connection: connected("youtube", "channel-1") }));
  assert.equal(receipt.code, "AUTH_FAILED");
  assert.equal(requests.length, 1);
});

test("YouTube is retryable when the session could not open, since no bytes were sent", async () => {
  const { transport, requests } = scripted([reply(503, { error: { message: "backend" } })]);
  const receipt = await new YouTubeShortsChannel({ transport }).publish(request({ connection: connected("youtube", "channel-1") }));
  assert.equal(receipt.code, "RETRYABLE");
  assert.equal(requests.length, 1);
});

test("YouTube with no upload session returned is unconfirmed", async () => {
  const { transport, requests } = scripted([reply(200, "", {})]);
  const receipt = await new YouTubeShortsChannel({ transport }).publish(request({ connection: connected("youtube", "channel-1") }));
  assert.equal(receipt.code, "UNCONFIRMED");
  assert.equal(requests.length, 1);
});

test("YouTube does not report a video after a failed byte upload, and sends the bytes once", async () => {
  const { transport, requests } = scripted([reply(200, "", { location: "https://upload.example.test/s" }), reply(500, { error: { message: "x" } })]);
  const receipt = await new YouTubeShortsChannel({ transport }).publish(request({ connection: connected("youtube", "channel-1") }));
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.code, "UNCONFIRMED");
  assert.equal(receipt.externalId, "");
  assert.equal(requests.length, 2);
});

test("YouTube reports an upload response with no video id as unconfirmed", async () => {
  const { transport } = scripted([reply(200, "", { location: "https://upload.example.test/s" }), reply(200, { kind: "youtube#video" })]);
  const receipt = await new YouTubeShortsChannel({ transport }).publish(request({ connection: connected("youtube", "channel-1") }));
  assert.equal(receipt.code, "UNCONFIRMED");
  assert.equal(receipt.externalId, "");
});
