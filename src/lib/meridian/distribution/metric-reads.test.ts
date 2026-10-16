import assert from "node:assert/strict";
import test from "node:test";
import type { Transport, TransportRequest } from "../providers/http.ts";
import { YOUTUBE_UPLOAD_SCOPE } from "./connection.ts";
import { FacebookPagesChannel } from "./facebook.ts";
import { InstagramReelsChannel } from "./instagram.ts";
import { parseInstagramInsights, readInstagramMetrics, readTikTokMetrics, readYouTubeMetrics } from "./metric-reads.ts";
import { TikTokOrganicChannel } from "./tiktok.ts";
import type { OrganicConnection, OrganicPlatform } from "./types.ts";
import { YouTubeShortsChannel } from "./youtube.ts";

// Every test reads a recorded fixture through a transport. No request leaves the process.

const NOW = new Date("2026-10-16T10:00:00.000Z");

/** A transport that answers every request with the given status and body, and keeps each request it was sent. */
function recording(status: number, body: unknown) {
  const requests: TransportRequest[] = [];
  const transport: Transport = async (request) => {
    requests.push(request);
    return { status, body: typeof body === "string" ? body : JSON.stringify(body), headers: {} };
  };
  return { transport, requests };
}

/** A connected account, as resolveOrganicConnection returns one: a stored token, and the scopes it declares when it declares any. */
function connectedAs(platform: OrganicPlatform, scopes: string[] | null = null): OrganicConnection {
  return { connected: true, platform, accountId: "acct-1", accountName: "Fixture account", accessToken: "fixture-token", scopes };
}

/** The Instagram media insights answer, shaped as the reference documents it: one item per metric, its value in values[0]. */
const INSTAGRAM_INSIGHTS = {
  data: [
    { name: "views", period: "lifetime", values: [{ value: 1500 }], title: "Views", id: "17900000000000001/insights/views/lifetime" },
    { name: "reach", period: "lifetime", values: [{ value: 1200 }], title: "Reach", id: "17900000000000001/insights/reach/lifetime" },
    { name: "likes", period: "lifetime", values: [{ value: 80 }], title: "Likes", id: "17900000000000001/insights/likes/lifetime" },
    { name: "comments", period: "lifetime", values: [{ value: 6 }], title: "Comments", id: "17900000000000001/insights/comments/lifetime" },
    { name: "shares", period: "lifetime", values: [{ value: 3 }], title: "Shares", id: "17900000000000001/insights/shares/lifetime" },
    { name: "saved", period: "lifetime", values: [{ value: 12 }], title: "Saved", id: "17900000000000001/insights/saved/lifetime" },
  ],
};

test("Instagram insights: each reported metric is stored with its value, and the read time is the observed date", async () => {
  const { transport, requests } = recording(200, INSTAGRAM_INSIGHTS);
  const reading = await readInstagramMetrics(transport, { externalId: "17900000000000001", accessToken: "fixture-token" }, NOW);
  assert.equal(reading.status, "observed");
  if (reading.status !== "observed") return;
  assert.equal(reading.observedAt, NOW.toISOString());
  assert.equal(reading.metrics.views, 1500);
  assert.equal(reading.metrics.reach, 1200);
  assert.equal(reading.metrics.likes, 80);
  assert.equal(reading.metrics.comments, 6);
  assert.equal(reading.metrics.shares, 3);
  assert.equal(reading.metrics.saves, 12, "the saved metric is stored as saves");
  assert.equal(reading.metrics.threeSecondViews, null, "no 3-second metric is reported for a Reel, so it is null");
  assert.equal(reading.metrics.completionRate, null);
  assert.equal(reading.metrics.averageWatchTimeSeconds, null, "the watch-time unit is not documented here, so it is null");

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, "GET");
  assert.match(requests[0]?.url ?? "", /\/17900000000000001\/insights\?metric=views,reach,likes,comments,shares,saved$/);
  assert.equal(requests[0]?.headers.Authorization, "Bearer fixture-token");
});

test("a metric the answer does not carry is null, and a reported zero stays zero", async () => {
  const { transport } = recording(200, { data: [{ name: "views", values: [{ value: 0 }] }, { name: "reach", values: [] }] });
  const reading = await readInstagramMetrics(transport, { externalId: "179", accessToken: "t" }, NOW);
  assert.equal(reading.status, "observed");
  if (reading.status !== "observed") return;
  assert.equal(reading.metrics.views, 0, "a reported zero is a value");
  assert.equal(reading.metrics.reach, null, "a metric with no value is not a zero");
  assert.equal(reading.metrics.likes, null, "a metric that was not returned is not a zero");
});

test("an Instagram answer with none of the requested metrics is a failure, not an empty observation", async () => {
  const { transport } = recording(200, { data: [{ name: "ig_reels_avg_watch_time", values: [{ value: 5 }] }] });
  const reading = await readInstagramMetrics(transport, { externalId: "179", accessToken: "t" }, NOW);
  assert.equal(reading.status, "failed");
  assert.match(reading.status === "failed" ? reading.reason : "", /no metric for this media/);
});

test("a refused Instagram read stores nothing, and its reason keeps the platform's message without the token", async () => {
  const { transport } = recording(400, { error: { message: "Invalid parameter access_token=abc123secret", code: 100 } });
  const reading = await readInstagramMetrics(transport, { externalId: "179", accessToken: "t" }, NOW);
  assert.equal(reading.status, "failed");
  if (reading.status !== "failed") return;
  assert.match(reading.reason, /Instagram refused the metrics read \(HTTP 400\)/);
  assert.match(reading.reason, /Nothing was stored\./);
  assert.doesNotMatch(reading.reason, /abc123secret/, "a token in the platform's message is redacted");
});

test("a transport failure on an Instagram read is a failed read, never a zero", async () => {
  const transport: Transport = async () => {
    throw new Error("socket closed");
  };
  const reading = await readInstagramMetrics(transport, { externalId: "179", accessToken: "t" }, NOW);
  assert.equal(reading.status, "failed");
  if (reading.status !== "failed") return;
  assert.match(reading.reason, /did not answer the metrics read/);
});

test("parseInstagramInsights returns null when data is not a list", () => {
  assert.equal(parseInstagramInsights({}), null);
  assert.equal(parseInstagramInsights({ data: "views" }), null);
  assert.equal(parseInstagramInsights(null), null);
});

test("the Instagram channel reads through the connected account and sends nothing without one", async () => {
  const connected = recording(200, INSTAGRAM_INSIGHTS);
  const channel = new InstagramReelsChannel({ transport: connected.transport });
  const reading = await channel.fetchMetrics("17900000000000001", connectedAs("instagram"));
  assert.equal(reading.status, "observed");
  assert.equal(connected.requests.length, 1);

  const none = recording(200, INSTAGRAM_INSIGHTS);
  const unconnected = new InstagramReelsChannel({ transport: none.transport });
  const notConnected = await unconnected.fetchMetrics("17900000000000001", undefined);
  assert.equal(notConnected.status, "not_connected", "no stored token is not a zero or a success");
  assert.equal(none.requests.length, 0, "no request is sent without a connection");

  const stored = await unconnected.fetchMetrics("17900000000000001", {
    connected: false,
    platform: "instagram",
    reason: "No Instagram account is connected for this brand.",
  });
  assert.deepEqual(stored, { status: "not_connected", reason: "No Instagram account is connected for this brand." });
  assert.equal(none.requests.length, 0);
});

test("YouTube statistics: counts are read from their text, and a hidden like count stays null", async () => {
  const { transport, requests } = recording(200, {
    items: [{ id: "abc123", statistics: { viewCount: "3057", commentCount: "12" } }],
  });
  const reading = await readYouTubeMetrics(transport, { externalId: "abc123", accessToken: "fixture-token" }, NOW);
  assert.equal(reading.status, "observed");
  if (reading.status !== "observed") return;
  assert.equal(reading.metrics.views, 3057);
  assert.equal(reading.metrics.likes, null, "likeCount is absent when the owner hides likes, so it is null");
  assert.equal(reading.metrics.comments, 12);
  assert.equal(reading.metrics.shares, null, "the statistics read reports no shares");
  assert.equal(reading.metrics.saves, null);
  assert.equal(reading.metrics.reach, null);
  assert.equal(reading.observedAt, NOW.toISOString());
  assert.equal(requests[0]?.method, "GET");
  assert.match(requests[0]?.url ?? "", /youtube\/v3\/videos\?part=statistics&id=abc123$/);
  assert.equal(requests[0]?.headers.Authorization, "Bearer fixture-token");
});

test("a YouTube zero count stays zero, and a video with no statistics or no counts is a failure", async () => {
  const zero = await readYouTubeMetrics(recording(200, { items: [{ id: "a", statistics: { viewCount: "0", likeCount: "0" } }] }).transport, { externalId: "a", accessToken: "t" }, NOW);
  assert.equal(zero.status, "observed");
  if (zero.status === "observed") assert.equal(zero.metrics.views, 0);

  const none = await readYouTubeMetrics(recording(200, { items: [] }).transport, { externalId: "a", accessToken: "t" }, NOW);
  assert.equal(none.status, "failed", "an answer with no video is not a zero");

  const empty = await readYouTubeMetrics(recording(200, { items: [{ id: "a", statistics: {} }] }).transport, { externalId: "a", accessToken: "t" }, NOW);
  assert.equal(empty.status, "failed", "a statistics block with no count is not a zero");
});

test("a YouTube token that declares only the upload scope is not connected for reads, and no request is sent", async () => {
  const { transport, requests } = recording(200, { items: [{ id: "a", statistics: { viewCount: "1" } }] });
  const channel = new YouTubeShortsChannel({ transport });
  const reading = await channel.fetchMetrics("a", connectedAs("youtube", [YOUTUBE_UPLOAD_SCOPE]));
  assert.equal(reading.status, "not_connected");
  if (reading.status !== "not_connected") return;
  assert.match(reading.reason, /does not grant a read scope/);
  assert.equal(requests.length, 0);
});

test("a YouTube token with a read scope, or with no declared scopes, is read through the channel", async () => {
  const withRead = recording(200, { items: [{ id: "a", statistics: { viewCount: "7" } }] });
  const readScope = await new YouTubeShortsChannel({ transport: withRead.transport }).fetchMetrics(
    "a",
    connectedAs("youtube", ["https://www.googleapis.com/auth/youtube.readonly"]),
  );
  assert.equal(readScope.status, "observed");

  const undeclared = recording(200, { items: [{ id: "a", statistics: { viewCount: "7" } }] });
  const none = await new YouTubeShortsChannel({ transport: undeclared.transport }).fetchMetrics("a", connectedAs("youtube", null));
  assert.equal(none.status, "observed", "a token that declares no scopes is read, and the platform refuses it if it may not");
  assert.equal(undeclared.requests.length, 1);
});

test("the YouTube channel with no connection sends no request", async () => {
  const { transport, requests } = recording(200, { items: [{ id: "a", statistics: { viewCount: "1" } }] });
  const reading = await new YouTubeShortsChannel({ transport }).fetchMetrics("a", undefined);
  assert.equal(reading.status, "not_connected");
  assert.equal(requests.length, 0);
});

test("TikTok video query: counts are read for the video the query named, and the body names only that video", async () => {
  const { transport, requests } = recording(200, {
    data: {
      videos: [{ id: "7077642457847991554", view_count: 990, like_count: 45, comment_count: 7, share_count: 2 }],
    },
    error: { code: "ok", message: "", log_id: "fixture" },
  });
  const reading = await readTikTokMetrics(transport, { externalId: "7077642457847991554", accessToken: "fixture-token" }, NOW);
  assert.equal(reading.status, "observed");
  if (reading.status !== "observed") return;
  assert.equal(reading.metrics.views, 990);
  assert.equal(reading.metrics.likes, 45);
  assert.equal(reading.metrics.comments, 7);
  assert.equal(reading.metrics.shares, 2);
  assert.equal(reading.metrics.reach, null);
  assert.equal(reading.metrics.saves, null);
  assert.equal(requests[0]?.method, "POST");
  assert.match(requests[0]?.url ?? "", /v2\/video\/query\/\?fields=id,view_count,like_count,comment_count,share_count$/);
  assert.deepEqual(JSON.parse(requests[0]?.body as string), { filters: { video_ids: ["7077642457847991554"] } });
});

test("a TikTok answer whose error code is not ok is a failure, with the platform's message", async () => {
  const { transport } = recording(200, {
    data: {},
    error: { code: "access_token_invalid", message: "The access token has expired" },
  });
  const reading = await readTikTokMetrics(transport, { externalId: "70776", accessToken: "t" }, NOW);
  assert.equal(reading.status, "failed");
  if (reading.status !== "failed") return;
  assert.match(reading.reason, /access_token_invalid/);
  assert.match(reading.reason, /The access token has expired/);
});

test("a TikTok answer that does not include the requested video is a failure, not a zero", async () => {
  const { transport } = recording(200, { data: { videos: [{ id: "99999", view_count: 1 }] }, error: { code: "ok", message: "" } });
  const reading = await readTikTokMetrics(transport, { externalId: "70776", accessToken: "t" }, NOW);
  assert.equal(reading.status, "failed");
  if (reading.status !== "failed") return;
  assert.match(reading.reason, /did not return this video/);
});

test("a TikTok token without video.list is not connected for reads, and no request is sent", async () => {
  const { transport, requests } = recording(200, { data: { videos: [] }, error: { code: "ok", message: "" } });
  const channel = new TikTokOrganicChannel({ transport });
  const reading = await channel.fetchMetrics("70776", connectedAs("tiktok", ["video.publish"]));
  assert.equal(reading.status, "not_connected");
  if (reading.status !== "not_connected") return;
  assert.match(reading.reason, /video\.list/);
  assert.equal(requests.length, 0);

  const none = await channel.fetchMetrics("70776", undefined);
  assert.equal(none.status, "not_connected");
  assert.equal(requests.length, 0);
});

test("the TikTok channel reads a video the connected account can list", async () => {
  const { transport, requests } = recording(200, {
    data: { videos: [{ id: "70776", view_count: 5, like_count: 0, comment_count: 0, share_count: 0 }] },
    error: { code: "ok", message: "" },
  });
  const reading = await new TikTokOrganicChannel({ transport }).fetchMetrics("70776", connectedAs("tiktok", ["video.list"]));
  assert.equal(reading.status, "observed");
  if (reading.status === "observed") assert.equal(reading.metrics.likes, 0, "a reported zero stays zero");
  assert.equal(requests.length, 1);
});

test("Facebook Page metrics are not implemented: a connected Page gets not_implemented and no request, never a success", async () => {
  const { transport, requests } = recording(200, { id: "1", views: 10 });
  const channel = new FacebookPagesChannel({ transport });
  const reading = await channel.fetchMetrics("1", connectedAs("facebook"));
  assert.equal(reading.status, "not_implemented");
  if (reading.status === "not_implemented") assert.match(reading.reason, /not implemented in this build/);
  assert.equal(requests.length, 0, "no request is built for a Page video");

  const none = await channel.fetchMetrics("1", undefined);
  assert.equal(none.status, "not_connected");
});
