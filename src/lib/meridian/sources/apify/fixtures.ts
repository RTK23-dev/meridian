// Fixtures for the Apify Instagram actors, for tests only.
//
// THESE ARE NOT LIVE RESPONSES. They are built from the field names and shapes that docs.apify.com documents for
// apify/instagram-hashtag-scraper and apify/instagram-reel-scraper (read 2026-10-15; see docs/engine/PROVIDER_APIS.md). The
// accounts, shortcodes and counts are invented. No test calls Apify. The owner's live run records the real shapes.

import { INSTAGRAM_VOLUME_CONFIG } from "./config.ts";
import type { ApifyClient, ApifyRunCall, ApifyRunResult } from "./client.ts";

/** A hashtag-search item for a reel (documented sample shape: type "Video", videoPlayCount, likesCount, commentsCount). */
export function hashtagReelItem(index: number, handle = "fixture_creator_a"): Record<string, unknown> {
  return {
    id: `fixture-hashtag-${index}`,
    type: "Video",
    url: `https://www.instagram.com/reel/FIXTURE_H${index}/`,
    shortCode: `FIXTURE_H${index}`,
    ownerUsername: handle,
    timestamp: "2026-10-10T09:00:00.000Z",
    caption: `Fixture caption ${index} #skincare`,
    hashtags: ["skincare"],
    videoPlayCount: 12000 + index * 100,
    likesCount: -1,
    commentsCount: 85,
    videoDuration: 22.5,
  };
}

/** A hashtag-search item that is a photo: the search returns these too, and they are not reel candidates. */
export const HASHTAG_PHOTO_ITEM: Record<string, unknown> = {
  id: "fixture-hashtag-photo",
  type: "Image",
  url: "https://www.instagram.com/p/FIXTURE_PHOTO1/",
  shortCode: "FIXTURE_PHOTO1",
  ownerUsername: "fixture_creator_b",
  timestamp: "2026-10-09T09:00:00.000Z",
  caption: "Fixture photo",
  hashtags: [],
  likesCount: 40,
  commentsCount: 2,
};

/** An item the candidate reader must refuse: its link is not on Instagram, and it names no owner. */
export const UNREADABLE_ITEM: Record<string, unknown> = {
  id: "fixture-unreadable",
  type: "Video",
  url: "https://example.com/not-instagram",
  videoPlayCount: 999,
  commentsCount: 1,
};

/** A reel from the reel actor for one creator (documented shape: ownerUsername, videoPlayCount, likesCount, commentsCount, timestamp). */
export function creatorReel(handle: string, index: number, views: number | null): Record<string, unknown> {
  const reel: Record<string, unknown> = {
    id: `fixture-${handle}-${index}`,
    type: "Video",
    url: `https://www.instagram.com/p/FIXTURE_${handle.toUpperCase()}_${index}/`,
    shortCode: `FIXTURE_${handle.toUpperCase()}_${index}`,
    ownerUsername: handle,
    timestamp: new Date(Date.UTC(2026, 9, 1 + index)).toISOString(),
    caption: "",
    hashtags: [],
    likesCount: 10,
    commentsCount: 3,
  };
  if (views !== null) reel.videoPlayCount = views;
  return reel;
}

/** Thirty reels of one creator with the given view counts, newest first. */
export function creatorReelSet(handle: string, views: Array<number | null>): Record<string, unknown>[] {
  return views.map((value, index) => creatorReel(handle, index, value));
}

/** The answer a recorded actor gives: its items, or a failure with its reason. */
export type RecordedAnswer = { items: unknown[] } | { failed: string };

/**
 * A client that answers each actor from a recorded answer and keeps every call it was asked for, so a test can check the
 * inputs and the caps. An actor with no recorded answer fails, and it never returns an empty success.
 */
export function recordedApifyClient(
  answers: Partial<Record<string, RecordedAnswer>>,
  options: { connected?: boolean; reason?: string | null } = {},
): ApifyClient & { calls: ApifyRunCall[] } {
  const calls: ApifyRunCall[] = [];
  const connected = options.connected ?? true;
  const reason = options.reason ?? null;
  return {
    calls,
    async connection() {
      return { connected, reason: connected ? null : reason };
    },
    async runSync(call): Promise<ApifyRunResult> {
      calls.push(call);
      if (!connected) return { status: "not_connected", reason: reason ?? "Apify is not connected." };
      const answer = answers[call.actorId];
      if (!answer) return { status: "failed", reason: `No recorded answer for ${call.actorId}.` };
      if ("failed" in answer) return { status: "failed", reason: answer.failed };
      return { status: "ok", items: answer.items.slice(0, call.maxItems) };
    },
  };
}

/** The niche and creator actor ids, as the config names them, for building answers in tests. */
export const ACTORS = INSTAGRAM_VOLUME_CONFIG.actors;
