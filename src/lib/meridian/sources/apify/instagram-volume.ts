// Instagram discovery at volume: the inputs the two Apify actors take, and the reading of what they return.
//
// Apify's output is untrusted data. Every field is checked by type here, and an unreadable value is null, never 0 and never a
// guess (AGENTS.md rule 1). Field names are the ones docs.apify.com documents (see docs/engine/PROVIDER_APIS.md, Apify).
// Where the docs do not say what a field means, the choice made here is named in a comment.

import { INSTAGRAM_VOLUME_CONFIG } from "./config.ts";

/**
 * The view count used for ratings. The docs list two counts, videoPlayCount and videoViewCount, and do not define how they
 * differ. videoPlayCount is the one present on every reel sample the docs show, for both actors, so it is the one used for
 * the candidate and for the baseline alike. The owner confirms this at the first live run.
 */
export const VIEWS_METRIC = "videoPlayCount" as const;

/** One reel as the actors report it, after its fields were checked. Unknown numbers are null. */
export type ReelCandidate = {
  /** Apify's id for the item. Null when the item has none. */
  externalId: string | null;
  /** The reel's Instagram address, https and on instagram.com. */
  permalink: string;
  /** The owner's handle without "@". */
  creatorHandle: string;
  caption: string;
  /** Hashtags without "#", lower case. Only letters, digits and underscores are kept. */
  hashtags: string[];
  /** The post time as an ISO string, or null when the item has no readable time. */
  postedAt: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  /** Whether the item is a video (Apify's type "Video"). A hashtag search also returns photos and carousels. */
  isVideo: boolean;
};

/** The hashtags a niche searches, from the run's niche text. Commas, semicolons, line breaks and "#" separate terms. */
export function nicheHashtags(niche: string, limit: number = INSTAGRAM_VOLUME_CONFIG.maxHashtagsPerRun): string[] {
  const terms: string[] = [];
  for (const piece of niche.split(/[,;\n#]+/)) {
    // "skin care" becomes "skincare", because an Instagram hashtag has no spaces.
    const term = piece.toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, "");
    if (term && !terms.includes(term)) terms.push(term);
    if (terms.length >= limit) break;
  }
  return terms;
}

/** Input for the hashtag actor: one hashtag, posts (the docs' example value), and at most resultsLimit items. */
export function hashtagInput(hashtag: string, resultsLimit: number): Record<string, unknown> {
  return { hashtags: [hashtag], resultsType: "posts", resultsLimit };
}

/** Input for the reel actor: a creator's most recent reels. Pinned reels are skipped, so the baseline is the latest reels. */
export function creatorReelsInput(handle: string, resultsLimit: number): Record<string, unknown> {
  return { username: [handle], resultsLimit, skipPinnedPosts: true };
}

/** Input for the reel actor: one reel, by its address. The docs accept a reel URL in the username field. Pinned skipping is off, so the reel is not dropped. */
export function reelUrlInput(permalink: string): Record<string, unknown> {
  return { username: [permalink], resultsLimit: 1 };
}

function countOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/** A link on instagram.com over https, or null. */
function instagramPermalink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || (host !== "instagram.com" && !host.endsWith(".instagram.com"))) return null;
  return url.toString();
}

function externalIdOf(item: Record<string, unknown>): string | null {
  if (typeof item.id === "string" && item.id.trim()) return item.id.trim();
  if (typeof item.id === "number" && Number.isFinite(item.id)) return String(item.id);
  if (typeof item.shortCode === "string" && item.shortCode.trim()) return item.shortCode.trim();
  return null;
}

function postedAtOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function hashtagsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const tag = entry.trim().replace(/^#/, "").toLowerCase();
    if (/^[\p{L}\p{N}_]+$/u.test(tag)) tags.push(tag);
  }
  return tags;
}

/**
 * One item of either actor, read into a candidate. Returns null when the item cannot be identified: no link on Instagram,
 * or no owner. Such an item is not stored, because it could not be found again or rated against its creator.
 * Likes of -1 mean the creator hid the count (docs), so they read as null.
 */
export function parseReelItem(raw: unknown): ReelCandidate | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const permalink = instagramPermalink(item.url);
  const creatorHandle = typeof item.ownerUsername === "string" ? item.ownerUsername.trim().replace(/^@/, "") : "";
  if (!permalink || !creatorHandle) return null;
  return {
    externalId: externalIdOf(item),
    permalink,
    creatorHandle,
    caption: typeof item.caption === "string" ? item.caption.slice(0, 2200) : "",
    hashtags: hashtagsOf(item.hashtags),
    postedAt: postedAtOf(item.timestamp),
    views: countOrNull(item[VIEWS_METRIC]),
    likes: countOrNull(item.likesCount),
    comments: countOrNull(item.commentsCount),
    isVideo: typeof item.type === "string" && item.type.toLowerCase() === "video",
  };
}

/** The median of whole numbers, rounded to a whole number (a view count is stored as an integer). Null for no values. */
export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(median);
}

/** Whether two handles name the same account. Case and a leading "@" do not count. */
export function sameCreator(a: string, b: string): boolean {
  const normal = (handle: string) => handle.trim().replace(/^@/, "").toLowerCase();
  return normal(a) !== "" && normal(a) === normal(b);
}

/** A key that names one reel however its address is written. The shortcode is the part after /p/, /reel/ or /tv/. */
export function reelKey(permalink: string): string {
  const shortcode = /\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/.exec(permalink);
  if (shortcode) return `shortcode:${shortcode[1]}`;
  return `address:${permalink.trim().toLowerCase().replace(/\/+$/, "")}`;
}

export type CreatorBaseline =
  | { status: "measured"; median: number; sampleSize: number; reason: "" }
  | { status: "insufficient" | "failed"; median: null; sampleSize: number; reason: string };

/**
 * A creator's baseline: the median view count of the creator's own reels in the list. Reels by other accounts are ignored.
 * Fewer than `minimum` reels with a view count, or a median of zero, is "insufficient" with the reason, and no median is made up.
 */
export function creatorBaseline(
  reels: readonly ReelCandidate[],
  handle: string,
  minimum: number = INSTAGRAM_VOLUME_CONFIG.minimumBaselineViews,
): CreatorBaseline {
  const own = reels.filter((reel) => sameCreator(reel.creatorHandle, handle));
  if (own.length === 0) {
    return { status: "insufficient", median: null, sampleSize: 0, reason: `The reel source returned no reels for @${handle.replace(/^@/, "")}.` };
  }
  const views = own.map((reel) => reel.views).filter((value): value is number => value !== null);
  if (views.length < minimum) {
    return {
      status: "insufficient",
      median: null,
      sampleSize: views.length,
      reason: `Only ${views.length} of the last ${own.length} reels report a view count; ${minimum} are needed for a creator median.`,
    };
  }
  const median = medianOf(views);
  if (median === null) {
    return { status: "insufficient", median: null, sampleSize: views.length, reason: "No view count was reported, so no median was made." };
  }
  if (median <= 0) {
    return { status: "insufficient", median: null, sampleSize: views.length, reason: "The creator's median view count is zero, so a ratio is not defined." };
  }
  return { status: "measured", median, sampleSize: views.length, reason: "" };
}
