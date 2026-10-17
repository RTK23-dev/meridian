/**
 * Organic metric reads. Each reader sends one documented request for one post, through the workspace's own stored token, and returns
 * what the platform reported with the time it was read. A metric the answer does not carry is null, never zero. A refused or failed
 * read returns its reason and stores nothing. The channel decides whether a connection exists before a reader is called.
 *
 * Documentation read 2026-10-16 (current platform references, through Context7):
 *   Instagram: GET /{media-id}/insights?metric=views,reach,likes,comments,shares,saved. The answer is `data`, one item per metric with
 *     `name` and `values[0].value`. https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights
 *     The metric `plays` is deprecated from v22.0, and `views` is the metric the reference lists. The read uses the version of the Reel
 *     read (TRIAL_GRAPH_BASE). Not verified live.
 *   YouTube: GET /youtube/v3/videos?part=statistics&id={id}. `items[0].statistics` holds viewCount, likeCount (absent when the owner
 *     hides likes) and commentCount, as strings. https://developers.google.com/youtube/v3/docs/videos
 *     The statistics for a video are read here, not the YouTube Analytics reports, so watch time and shares stay null.
 *   TikTok: POST /v2/video/query/?fields=id,view_count,like_count,comment_count,share_count with filters.video_ids (up to 20), scope
 *     video.list. Its error object carries code "ok" on success. https://developers.tiktok.com/docs/en/tiktok-api-v2-video-query
 *   Facebook Page video: GET /{video-id}/video_insights?metric=total_video_views,total_video_avg_time_watched.
 *     `data` is one item per metric, with `name` and `values[0].value`. total_video_avg_time_watched is milliseconds and is stored as
 *     seconds. Unique views are not requested: they are not reach, and a removed metric can fail the whole read. Likes, comments and
 *     shares are not on this edge.
 *     https://developers.facebook.com/docs/graph-api/reference/video/video_insights
 *
 * Not verified live: no request in this build has been sent to any of these services.
 */

import { redactSecrets } from "../observability/redact.ts";
import type { Transport, TransportRequest, TransportResponse } from "../providers/http.ts";
import { GRAPH_BASE, TRIAL_GRAPH_BASE, parseJsonBody } from "./graph.ts";
import type { OrganicMetricsReading, OrganicTelemetryMetrics } from "./types.ts";

export type MetricReadInput = {
  /** The platform's id of the post: a media id, a video id. */
  externalId: string;
  /** The workspace's own stored access token. It is the only token a read uses. */
  accessToken: string;
};

/** The Instagram media metrics requested. Each one has a field, or is not stored. */
export const INSTAGRAM_MEDIA_METRICS = ["views", "reach", "likes", "comments", "shares", "saved"] as const;

const INSTAGRAM_FIELD: Record<string, keyof OrganicTelemetryMetrics> = {
  views: "views",
  reach: "reach",
  likes: "likes",
  comments: "comments",
  shares: "shares",
  saved: "saves",
};

const YOUTUBE_STATISTICS_URL = "https://www.googleapis.com/youtube/v3/videos";
const TIKTOK_VIDEO_QUERY_URL = "https://open.tiktokapis.com/v2/video/query/?fields=id,view_count,like_count,comment_count,share_count";

/** The Page video metrics requested. Unique views are not requested and are not stored as reach. */
export const FACEBOOK_VIDEO_METRICS = ["total_video_views", "total_video_avg_time_watched"] as const;

export function emptyOrganicMetrics(): OrganicTelemetryMetrics {
  return {
    views: null,
    reach: null,
    threeSecondViews: null,
    averageWatchTimeSeconds: null,
    completionRate: null,
    likes: null,
    comments: null,
    shares: null,
    saves: null,
  };
}

/** Reads Instagram media insights. Needs the media id the publish returned. */
export async function readInstagramMetrics(transport: Transport, input: MetricReadInput, now: Date): Promise<OrganicMetricsReading> {
  const label = "Instagram";
  const mediaId = input.externalId.trim();
  if (!mediaId) return failed(`${label} has no media id for this post, so nothing was read. Nothing was stored.`);
  const answer = await ask(label, transport, {
    method: "GET",
    url: `${TRIAL_GRAPH_BASE}/${encodeURIComponent(mediaId)}/insights?metric=${INSTAGRAM_MEDIA_METRICS.join(",")}`,
    headers: { Authorization: `Bearer ${input.accessToken}` },
  });
  if (!answer.ok) return failed(answer.reason);
  const metrics = parseInstagramInsights(answer.json);
  if (!metrics) return failed(`${label} returned no metric for this media. Nothing was stored.`);
  return observed(metrics, now);
}

/** Reads a YouTube video's public statistics through the workspace's token. A token with no read scope is refused before the call. */
export async function readYouTubeMetrics(transport: Transport, input: MetricReadInput, now: Date): Promise<OrganicMetricsReading> {
  const label = "YouTube";
  const videoId = input.externalId.trim();
  if (!videoId) return failed(`${label} has no video id for this post, so nothing was read. Nothing was stored.`);
  const answer = await ask(label, transport, {
    method: "GET",
    url: `${YOUTUBE_STATISTICS_URL}?${new URLSearchParams({ part: "statistics", id: videoId }).toString()}`,
    headers: { Authorization: `Bearer ${input.accessToken}` },
  });
  if (!answer.ok) return failed(answer.reason);
  const items = recordOf(answer.json).items;
  const first = Array.isArray(items) ? recordOf(items[0]) : null;
  if (!first || !("statistics" in first)) return failed(`${label} returned no video for this id. Nothing was stored.`);
  const statistics = recordOf(first.statistics);
  const metrics: OrganicTelemetryMetrics = {
    ...emptyOrganicMetrics(),
    views: numberOf(statistics.viewCount),
    // likeCount is absent when the owner hides likes, so it is null and not zero.
    likes: numberOf(statistics.likeCount),
    comments: numberOf(statistics.commentCount),
  };
  if (metrics.views === null && metrics.likes === null && metrics.comments === null) {
    return failed(`${label} returned no count for this video. Nothing was stored.`);
  }
  return observed(metrics, now);
}

/** Reads a TikTok video's counts through the workspace's token. Needs the video id TikTok returned for the post. */
export async function readTikTokMetrics(transport: Transport, input: MetricReadInput, now: Date): Promise<OrganicMetricsReading> {
  const label = "TikTok";
  const videoId = input.externalId.trim();
  if (!videoId) return failed(`${label} has no video id for this post, so nothing was read. Nothing was stored.`);
  const answer = await ask(label, transport, {
    method: "POST",
    url: TIKTOK_VIDEO_QUERY_URL,
    headers: { Authorization: `Bearer ${input.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ filters: { video_ids: [videoId] } }),
  });
  if (!answer.ok) return failed(answer.reason);
  const error = recordOf(recordOf(answer.json).error);
  const code = typeof error.code === "string" ? error.code : "ok";
  if (code !== "ok") {
    return failed(`${label} refused the metrics read (${code})${detailOf(error.message)}. Nothing was stored.`);
  }
  const videos = recordOf(recordOf(answer.json).data).videos;
  const video = Array.isArray(videos) ? videos.map(recordOf).find((row) => String(row.id ?? "") === videoId) : undefined;
  if (!video) return failed(`${label} did not return this video. Nothing was stored.`);
  const metrics: OrganicTelemetryMetrics = {
    ...emptyOrganicMetrics(),
    views: numberOf(video.view_count),
    likes: numberOf(video.like_count),
    comments: numberOf(video.comment_count),
    shares: numberOf(video.share_count),
  };
  if (metrics.views === null && metrics.likes === null && metrics.comments === null && metrics.shares === null) {
    return failed(`${label} returned no count for this video. Nothing was stored.`);
  }
  return observed(metrics, now);
}

/** Reads a Facebook Page video's insights. Needs the video id the publish returned. */
export async function readFacebookVideoMetrics(transport: Transport, input: MetricReadInput, now: Date): Promise<OrganicMetricsReading> {
  const label = "Facebook Page";
  const videoId = input.externalId.trim();
  if (!videoId) return failed(`${label} has no video id for this post, so nothing was read. Nothing was stored.`);
  const answer = await ask(label, transport, {
    method: "GET",
    url: `${GRAPH_BASE}/${encodeURIComponent(videoId)}/video_insights?metric=${FACEBOOK_VIDEO_METRICS.join(",")}`,
    headers: { Authorization: `Bearer ${input.accessToken}` },
  });
  if (!answer.ok) return failed(answer.reason);
  const metrics = parseFacebookVideoInsights(answer.json);
  if (!metrics) return failed(`${label} returned no metric for this video. Nothing was stored.`);
  return observed(metrics, now);
}

/** The metric values of a Page video insights answer. Null when the answer carries none of the requested metrics. */
export function parseFacebookVideoInsights(json: unknown): OrganicTelemetryMetrics | null {
  const data = recordOf(json).data;
  if (!Array.isArray(data)) return null;
  const metrics = emptyOrganicMetrics();
  let found = 0;
  for (const item of data) {
    const row = recordOf(item);
    const name = typeof row.name === "string" ? row.name : "";
    const values = Array.isArray(row.values) ? row.values : [];
    const value = numberOf(recordOf(values[0]).value);
    if (value === null) continue;
    if (name === "total_video_views") metrics.views = value;
    else if (name === "total_video_avg_time_watched") metrics.averageWatchTimeSeconds = value / 1000;
    else continue;
    found += 1;
  }
  return found > 0 ? metrics : null;
}

/** The metric values of an Instagram insights answer. Null when the answer carries none of the requested metrics. */
export function parseInstagramInsights(json: unknown): OrganicTelemetryMetrics | null {
  const data = recordOf(json).data;
  if (!Array.isArray(data)) return null;
  const metrics = emptyOrganicMetrics();
  let found = 0;
  for (const item of data) {
    const row = recordOf(item);
    const field = typeof row.name === "string" ? INSTAGRAM_FIELD[row.name] : undefined;
    if (!field) continue;
    const values = Array.isArray(row.values) ? row.values : [];
    const value = numberOf(recordOf(values[0]).value);
    if (value === null) continue;
    metrics[field] = value;
    found += 1;
  }
  return found > 0 ? metrics : null;
}

type Answer = { ok: true; json: unknown } | { ok: false; reason: string };

/** One request. A transport error, a refusal or an unreadable answer is a failure with its reason, never a number. */
async function ask(label: string, transport: Transport, request: TransportRequest): Promise<Answer> {
  let response: TransportResponse;
  try {
    response = await transport(request);
  } catch {
    return { ok: false, reason: `${label} did not answer the metrics read. Nothing was stored.` };
  }
  const json = parseJsonBody(response.body);
  if (response.status < 200 || response.status >= 300) {
    const error = recordOf(recordOf(json).error);
    return { ok: false, reason: `${label} refused the metrics read (HTTP ${response.status})${detailOf(error.message)}. Nothing was stored.` };
  }
  return { ok: true, json };
}

function observed(metrics: OrganicTelemetryMetrics, now: Date): OrganicMetricsReading {
  return { status: "observed", metrics, observedAt: now.toISOString() };
}

function failed(reason: string): OrganicMetricsReading {
  return { status: "failed", reason };
}

function detailOf(message: unknown): string {
  if (typeof message !== "string") return "";
  const clean = redactSecrets(message).replace(/\s+/g, " ").trim().slice(0, 240);
  return clean ? `: ${clean}` : "";
}

/** A count the platform returned as a number or as numeric text. Anything else is not a count, so it is null. */
function numberOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
