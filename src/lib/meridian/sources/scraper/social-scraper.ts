/**
 * Universal Multi-Platform Social Media Scraper
 *
 * Scrapes public post metadata, captions, metrics, and media pointers across:
 * - Instagram Reels & Posts
 * - TikTok Videos
 * - YouTube Shorts & Videos
 * - Twitter / X Tweets & Videos
 * - Threads Posts
 * - Facebook Reels & Videos
 * - Pinterest Pins
 * - Reddit Posts & Media
 * - LinkedIn Posts
 * - Universal fallback for any web/social page (OpenGraph + JSON-LD)
 *
 * Uses public oEmbed endpoints and public HTML metadata with SSRF protection.
 * Never invents metrics when unreachable.
 */

import { fetchPublicHtml } from "../fetch-page.server.ts";

export type ScrapedSocialPlatform =
  | "instagram"
  | "tiktok"
  | "youtube"
  | "twitter"
  | "threads"
  | "facebook"
  | "pinterest"
  | "reddit"
  | "linkedin"
  | "other";

export type ScrapedSocialPost = {
  platform: ScrapedSocialPlatform;
  url: string;
  externalId?: string;
  authorHandle?: string;
  authorName?: string;
  title?: string;
  caption?: string;
  thumbnailUrl?: string;
  videoUrl?: string;
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  durationSeconds?: number;
  extractedAt: string;
  rawPayload?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// ID Extraction Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts shortcode from Instagram post, reel, or tv URL.
 */
export function extractInstagramShortcode(url: string): string | null {
  const match = url.match(/(?:reel|p|tv)\/([A-Za-z0-9_-]+)/);
  return match && match[1] ? match[1] : null;
}

/**
 * Extracts video ID from YouTube URL (watch, shorts, or youtu.be).
 */
export function extractYouTubeVideoId(url: string): string | null {
  const shortsMatch = url.match(/shorts\/([A-Za-z0-9_-]{11})/);
  if (shortsMatch && shortsMatch[1]) return shortsMatch[1];

  const watchMatch = url.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (watchMatch && watchMatch[1]) return watchMatch[1];

  const shareMatch = url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (shareMatch && shareMatch[1]) return shareMatch[1];

  const embedMatch = url.match(/embed\/([A-Za-z0-9_-]{11})/);
  if (embedMatch && embedMatch[1]) return embedMatch[1];

  return null;
}

/**
 * Extracts video ID from TikTok URL.
 */
export function extractTikTokVideoId(url: string): string | null {
  const match = url.match(/(?:video|v)\/(\d+)/);
  return match && match[1] ? match[1] : null;
}

/**
 * Extracts status ID from Twitter / X URL.
 */
export function extractTwitterStatusId(url: string): { statusId: string; user?: string } | null {
  const match = url.match(/(?:twitter\.com|x\.com)\/(?:#!\/)?([A-Za-z0-9_]+)\/status(?:es)?\/(\d+)/i);
  if (match && match[2]) {
    return { statusId: match[2], user: match[1] };
  }
  return null;
}

/**
 * Extracts post ID from Threads URL.
 */
export function extractThreadsPostId(url: string): { postId: string; user?: string } | null {
  const match = url.match(/threads\.(?:net|com)\/(?:@([A-Za-z0-9_.-]+)\/)?post\/([A-Za-z0-9_-]+)/i);
  if (match && match[2]) {
    return { postId: match[2], user: match[1] };
  }
  return null;
}

/**
 * Extracts video or post ID from Facebook URL.
 */
export function extractFacebookVideoId(url: string): string | null {
  const reelMatch = url.match(/reel\/(\d+)/i);
  if (reelMatch && reelMatch[1]) return reelMatch[1];

  const watchMatch = url.match(/watch\/?\?v=(\d+)/i);
  if (watchMatch && watchMatch[1]) return watchMatch[1];

  const videoMatch = url.match(/videos\/(\d+)/i);
  if (videoMatch && videoMatch[1]) return videoMatch[1];

  const fbWatchMatch = url.match(/fb\.watch\/([A-Za-z0-9_-]+)/i);
  if (fbWatchMatch && fbWatchMatch[1]) return fbWatchMatch[1];

  return null;
}

/**
 * Extracts pin ID from Pinterest URL.
 */
export function extractPinterestPinId(url: string): string | null {
  const pinMatch = url.match(/pinterest\.(?:com|[a-z]{2,3})\/pin\/(\d+)/i);
  if (pinMatch && pinMatch[1]) return pinMatch[1];

  const shortMatch = url.match(/pin\.it\/([A-Za-z0-9]+)/i);
  if (shortMatch && shortMatch[1]) return shortMatch[1];

  return null;
}

/**
 * Extracts subreddit and post ID from Reddit URL.
 */
export function extractRedditPostId(url: string): { postId: string; subreddit?: string } | null {
  const fullMatch = url.match(/reddit\.com\/r\/([A-Za-z0-9_]+)\/comments\/([A-Za-z0-9]+)/i);
  if (fullMatch && fullMatch[2]) {
    return { postId: fullMatch[2], subreddit: fullMatch[1] };
  }

  const shortMatch = url.match(/redd\.it\/([A-Za-z0-9]+)/i);
  if (shortMatch && shortMatch[1]) {
    return { postId: shortMatch[1] };
  }

  return null;
}

/**
 * Extracts activity ID from LinkedIn URL.
 */
export function extractLinkedInActivityId(url: string): string | null {
  const match = url.match(/linkedin\.com\/(?:posts\/|feed\/update\/urn:li:activity:)([A-Za-z0-9_.-]+)/i);
  return match && match[1] ? match[1] : null;
}

// ---------------------------------------------------------------------------
// HTML & Meta Parsing Helpers
// ---------------------------------------------------------------------------

function extractMetaTag(html: string, propertyOrName: string): string | undefined {
  const propRegex = new RegExp(
    `<meta\\s+[^>]*(?:property|name)=["'](?:${propertyOrName})["'][^>]*content=["']([^"']*)["']`,
    "i",
  );
  const match = html.match(propRegex);
  if (match && match[1]) return match[1].trim();

  // Reverse attribute order: content first, then property/name
  const reverseRegex = new RegExp(
    `<meta\\s+[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["'](?:${propertyOrName})["']`,
    "i",
  );
  const revMatch = html.match(reverseRegex);
  return revMatch && revMatch[1] ? revMatch[1].trim() : undefined;
}

function parseMetricString(str: string): number {
  const clean = str.replace(/,/g, "").trim();
  const mult = clean.endsWith("M") || clean.endsWith("m")
    ? 1_000_000
    : clean.endsWith("K") || clean.endsWith("k")
      ? 1_000
      : 1;
  const num = parseFloat(clean);
  return Number.isFinite(num) ? Math.round(num * mult) : 0;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function parseIsoDuration(durationStr: string): number | undefined {
  const match = durationStr.match(/PT(?:(\d+)M)?(?:(\d+)S)?/i);
  if (!match) return undefined;
  const minutes = match[1] ? parseInt(match[1], 10) : 0;
  const seconds = match[2] ? parseInt(match[2], 10) : 0;
  return minutes * 60 + seconds;
}

// ---------------------------------------------------------------------------
// Platform Scrapers
// ---------------------------------------------------------------------------

/**
 * Scrapes a public Instagram Reel or post.
 */
export async function scrapeInstagramPost(rawUrl: string): Promise<ScrapedSocialPost> {
  const shortcode = extractInstagramShortcode(rawUrl);
  const now = new Date().toISOString();

  if (!shortcode) {
    throw new Error(`Invalid Instagram URL: ${rawUrl}`);
  }

  const canonicalUrl = `https://www.instagram.com/reel/${shortcode}/`;
  const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;

  try {
    const { html } = await fetchPublicHtml(embedUrl);

    // Extract caption
    const captionMatch = html.match(/<div class="Caption"[\s\S]*?>([\s\S]*?)<\/div>/i) ||
      html.match(/class="CaptionText">([\s\S]*?)<\/span>/i);
    const caption = captionMatch && captionMatch[1] ? stripHtml(captionMatch[1]) : undefined;

    // Extract author
    const authorMatch = html.match(/class="UsernameText">([^<]+)<\/span>/i) ||
      html.match(/data-ios-link="user\?username=([^"]+)"/i);
    const authorHandle = authorMatch && authorMatch[1] ? authorMatch[1].trim() : undefined;

    // Extract likes count if visible in embed
    let likes: number | undefined;
    const likesMatch = html.match(/class="SocialContext">([\d,.]+[KMkm]?)\s+likes/i);
    if (likesMatch && likesMatch[1]) {
      likes = parseMetricString(likesMatch[1]);
    }

    // Extract thumbnail from image embed if present
    const thumbMatch = html.match(/class="EmbeddedMediaImage"[^>]*src="([^"]+)"/i);
    const thumbnailUrl = thumbMatch && thumbMatch[1] ? thumbMatch[1].replace(/&amp;/g, "&") : undefined;

    return {
      platform: "instagram",
      url: canonicalUrl,
      externalId: shortcode,
      authorHandle,
      authorName: authorHandle,
      caption,
      title: caption ? caption.slice(0, 100) : undefined,
      thumbnailUrl,
      likes,
      extractedAt: now,
    };
  } catch (err) {
    return {
      platform: "instagram",
      url: canonicalUrl,
      externalId: shortcode,
      extractedAt: now,
      rawPayload: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

/**
 * Scrapes a public TikTok video using oEmbed and public metadata.
 */
export async function scrapeTikTokPost(rawUrl: string): Promise<ScrapedSocialPost> {
  const now = new Date().toISOString();
  const videoId = extractTikTokVideoId(rawUrl);

  const oembedEndpoint = `https://www.tiktok.com/oembed?url=${encodeURIComponent(rawUrl)}`;
  try {
    const res = await fetch(oembedEndpoint, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    });

    if (res.ok) {
      const data = (await res.json()) as {
        title?: string;
        author_name?: string;
        author_unique_id?: string;
        thumbnail_url?: string;
        html?: string;
      };

      return {
        platform: "tiktok",
        url: rawUrl,
        externalId: videoId ?? undefined,
        authorHandle: data.author_unique_id || data.author_name,
        authorName: data.author_name,
        title: data.title,
        caption: data.title,
        thumbnailUrl: data.thumbnail_url,
        extractedAt: now,
        rawPayload: data,
      };
    }
  } catch {
    // Fall back to SSRF-protected page fetch
  }

  // Fallback public HTML scrape
  try {
    const { html } = await fetchPublicHtml(rawUrl);
    const title = extractMetaTag(html, "og:title") || extractMetaTag(html, "twitter:title");
    const caption = extractMetaTag(html, "og:description") || extractMetaTag(html, "description");
    const thumbnailUrl = extractMetaTag(html, "og:image") || extractMetaTag(html, "twitter:image");

    return {
      platform: "tiktok",
      url: rawUrl,
      externalId: videoId ?? undefined,
      title,
      caption,
      thumbnailUrl,
      extractedAt: now,
    };
  } catch (err) {
    return {
      platform: "tiktok",
      url: rawUrl,
      externalId: videoId ?? undefined,
      extractedAt: now,
      rawPayload: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

/**
 * Scrapes a public YouTube Shorts or regular video.
 */
export async function scrapeYouTubeShort(rawUrl: string): Promise<ScrapedSocialPost> {
  const videoId = extractYouTubeVideoId(rawUrl);
  const now = new Date().toISOString();

  if (!videoId) {
    throw new Error(`Invalid YouTube URL: ${rawUrl}`);
  }

  const canonicalUrl = `https://www.youtube.com/shorts/${videoId}`;

  try {
    const oembedEndpoint = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const res = await fetch(oembedEndpoint);

    let title: string | undefined;
    let authorName: string | undefined;
    let thumbnailUrl: string | undefined;

    if (res.ok) {
      const data = (await res.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
      title = data.title;
      authorName = data.author_name;
      thumbnailUrl = data.thumbnail_url;
    }

    let views: number | undefined;
    try {
      const { html } = await fetchPublicHtml(canonicalUrl);
      const viewsMatch = html.match(/itemprop="interactionCount"\s+content="(\d+)"/i) ||
        html.match(/"viewCount":"(\d+)"/i);
      if (viewsMatch && viewsMatch[1]) {
        views = parseInt(viewsMatch[1], 10);
      }
      if (!thumbnailUrl) {
        thumbnailUrl = extractMetaTag(html, "og:image");
      }
    } catch {
      // Keep oembed results
    }

    return {
      platform: "youtube",
      url: canonicalUrl,
      externalId: videoId,
      title,
      authorName,
      thumbnailUrl,
      views,
      extractedAt: now,
    };
  } catch (err) {
    return {
      platform: "youtube",
      url: canonicalUrl,
      externalId: videoId,
      extractedAt: now,
      rawPayload: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

/**
 * Scrapes a public Twitter / X post.
 */
export async function scrapeTwitterPost(rawUrl: string): Promise<ScrapedSocialPost> {
  const parsed = extractTwitterStatusId(rawUrl);
  const now = new Date().toISOString();

  const oembedEndpoint = `https://publish.twitter.com/oembed?url=${encodeURIComponent(rawUrl)}`;
  try {
    const res = await fetch(oembedEndpoint);
    if (res.ok) {
      const data = (await res.json()) as {
        author_name?: string;
        author_url?: string;
        html?: string;
        url?: string;
      };

      let caption: string | undefined;
      if (data.html) {
        const pMatch = data.html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
        caption = pMatch && pMatch[1] ? stripHtml(pMatch[1]) : stripHtml(data.html);
      }

      return {
        platform: "twitter",
        url: rawUrl,
        externalId: parsed?.statusId,
        authorName: data.author_name,
        authorHandle: parsed?.user,
        title: caption ? caption.slice(0, 100) : undefined,
        caption,
        extractedAt: now,
        rawPayload: data,
      };
    }
  } catch {
    // Fall back to SSRF-protected page fetch
  }

  try {
    const { html } = await fetchPublicHtml(rawUrl);
    const caption = extractMetaTag(html, "og:description") || extractMetaTag(html, "twitter:description");
    const thumbnailUrl = extractMetaTag(html, "og:image") || extractMetaTag(html, "twitter:image");
    const authorName = extractMetaTag(html, "twitter:creator") || parsed?.user;

    return {
      platform: "twitter",
      url: rawUrl,
      externalId: parsed?.statusId,
      authorHandle: parsed?.user,
      authorName,
      title: caption ? caption.slice(0, 100) : undefined,
      caption,
      thumbnailUrl,
      extractedAt: now,
    };
  } catch (err) {
    return {
      platform: "twitter",
      url: rawUrl,
      externalId: parsed?.statusId,
      authorHandle: parsed?.user,
      extractedAt: now,
      rawPayload: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

/**
 * Scrapes a public Threads post.
 */
export async function scrapeThreadsPost(rawUrl: string): Promise<ScrapedSocialPost> {
  const parsed = extractThreadsPostId(rawUrl);
  const now = new Date().toISOString();

  try {
    const { html } = await fetchPublicHtml(rawUrl);
    const caption = extractMetaTag(html, "og:description") || extractMetaTag(html, "description");
    const title = extractMetaTag(html, "og:title");
    const thumbnailUrl = extractMetaTag(html, "og:image");
    const videoUrl = extractMetaTag(html, "og:video");

    return {
      platform: "threads",
      url: rawUrl,
      externalId: parsed?.postId,
      authorHandle: parsed?.user,
      title,
      caption,
      thumbnailUrl,
      videoUrl,
      extractedAt: now,
    };
  } catch (err) {
    return {
      platform: "threads",
      url: rawUrl,
      externalId: parsed?.postId,
      authorHandle: parsed?.user,
      extractedAt: now,
      rawPayload: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

/**
 * Scrapes a public Facebook Reel or video post.
 */
export async function scrapeFacebookPost(rawUrl: string): Promise<ScrapedSocialPost> {
  const videoId = extractFacebookVideoId(rawUrl);
  const now = new Date().toISOString();

  try {
    const { html } = await fetchPublicHtml(rawUrl);
    const title = extractMetaTag(html, "og:title");
    const caption = extractMetaTag(html, "og:description") || extractMetaTag(html, "description");
    const thumbnailUrl = extractMetaTag(html, "og:image");
    const videoUrl = extractMetaTag(html, "og:video") || extractMetaTag(html, "og:video:secure_url");

    return {
      platform: "facebook",
      url: rawUrl,
      externalId: videoId ?? undefined,
      title,
      caption,
      thumbnailUrl,
      videoUrl,
      extractedAt: now,
    };
  } catch (err) {
    return {
      platform: "facebook",
      url: rawUrl,
      externalId: videoId ?? undefined,
      extractedAt: now,
      rawPayload: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

/**
 * Scrapes a public Pinterest Pin.
 */
export async function scrapePinterestPost(rawUrl: string): Promise<ScrapedSocialPost> {
  const pinId = extractPinterestPinId(rawUrl);
  const now = new Date().toISOString();

  const oembedEndpoint = `https://www.pinterest.com/oembed.json?url=${encodeURIComponent(rawUrl)}`;
  try {
    const res = await fetch(oembedEndpoint);
    if (res.ok) {
      const data = (await res.json()) as {
        title?: string;
        author_name?: string;
        thumbnail_url?: string;
      };

      return {
        platform: "pinterest",
        url: rawUrl,
        externalId: pinId ?? undefined,
        title: data.title,
        caption: data.title,
        authorName: data.author_name,
        thumbnailUrl: data.thumbnail_url,
        extractedAt: now,
        rawPayload: data,
      };
    }
  } catch {
    // Fall back to SSRF-protected page fetch
  }

  try {
    const { html } = await fetchPublicHtml(rawUrl);
    const title = extractMetaTag(html, "og:title");
    const caption = extractMetaTag(html, "og:description");
    const thumbnailUrl = extractMetaTag(html, "og:image");

    return {
      platform: "pinterest",
      url: rawUrl,
      externalId: pinId ?? undefined,
      title,
      caption,
      thumbnailUrl,
      extractedAt: now,
    };
  } catch (err) {
    return {
      platform: "pinterest",
      url: rawUrl,
      externalId: pinId ?? undefined,
      extractedAt: now,
      rawPayload: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

/**
 * Scrapes a public Reddit post or video clip.
 */
export async function scrapeRedditPost(rawUrl: string): Promise<ScrapedSocialPost> {
  const parsed = extractRedditPostId(rawUrl);
  const now = new Date().toISOString();

  // If we have subreddit and postId, try public .json endpoint
  if (parsed?.subreddit && parsed?.postId) {
    const jsonUrl = `https://www.reddit.com/r/${parsed.subreddit}/comments/${parsed.postId}.json`;
    try {
      const res = await fetch(jsonUrl, {
        headers: { "User-Agent": "Meridian-Scraper/1.0" },
      });
      if (res.ok) {
        const payload = (await res.json()) as Array<{
          data?: {
            children?: Array<{
              data?: {
                title?: string;
                selftext?: string;
                author?: string;
                score?: number;
                num_comments?: number;
                thumbnail?: string;
                media?: { reddit_video?: { fallback_url?: string; duration?: number } };
              };
            }>;
          };
        }>;

        const postData = payload[0]?.data?.children?.[0]?.data;
        if (postData) {
          const videoUrl = postData.media?.reddit_video?.fallback_url;
          const duration = postData.media?.reddit_video?.duration;

          return {
            platform: "reddit",
            url: rawUrl,
            externalId: parsed.postId,
            authorHandle: postData.author,
            authorName: postData.author,
            title: postData.title,
            caption: postData.selftext || postData.title,
            thumbnailUrl: postData.thumbnail && postData.thumbnail.startsWith("http") ? postData.thumbnail : undefined,
            videoUrl,
            likes: postData.score,
            comments: postData.num_comments,
            durationSeconds: duration,
            extractedAt: now,
            rawPayload: postData,
          };
        }
      }
    } catch {
      // Fall through to page fetch
    }
  }

  try {
    const { html } = await fetchPublicHtml(rawUrl);
    const title = extractMetaTag(html, "og:title");
    const caption = extractMetaTag(html, "og:description");
    const thumbnailUrl = extractMetaTag(html, "og:image");

    return {
      platform: "reddit",
      url: rawUrl,
      externalId: parsed?.postId,
      title,
      caption,
      thumbnailUrl,
      extractedAt: now,
    };
  } catch (err) {
    return {
      platform: "reddit",
      url: rawUrl,
      externalId: parsed?.postId,
      extractedAt: now,
      rawPayload: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

/**
 * Scrapes a public LinkedIn post.
 */
export async function scrapeLinkedInPost(rawUrl: string): Promise<ScrapedSocialPost> {
  const activityId = extractLinkedInActivityId(rawUrl);
  const now = new Date().toISOString();

  try {
    const { html } = await fetchPublicHtml(rawUrl);
    const title = extractMetaTag(html, "og:title");
    const caption = extractMetaTag(html, "og:description") || extractMetaTag(html, "description");
    const thumbnailUrl = extractMetaTag(html, "og:image");

    return {
      platform: "linkedin",
      url: rawUrl,
      externalId: activityId ?? undefined,
      title,
      caption,
      thumbnailUrl,
      extractedAt: now,
    };
  } catch (err) {
    return {
      platform: "linkedin",
      url: rawUrl,
      externalId: activityId ?? undefined,
      extractedAt: now,
      rawPayload: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

/**
 * Universal fallback scraper extracting OpenGraph, Twitter Cards, and Schema.org JSON-LD.
 */
export async function scrapeUniversalUrl(rawUrl: string): Promise<ScrapedSocialPost> {
  const now = new Date().toISOString();

  try {
    const { html } = await fetchPublicHtml(rawUrl);

    const title = extractMetaTag(html, "og:title") ||
      extractMetaTag(html, "twitter:title") ||
      (() => {
        const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        return m && m[1] ? stripHtml(m[1]) : undefined;
      })();

    const caption = extractMetaTag(html, "og:description") ||
      extractMetaTag(html, "twitter:description") ||
      extractMetaTag(html, "description");

    const thumbnailUrl = extractMetaTag(html, "og:image") || extractMetaTag(html, "twitter:image");
    const videoUrl = extractMetaTag(html, "og:video") || extractMetaTag(html, "og:video:url");
    const authorName = extractMetaTag(html, "author") ||
      extractMetaTag(html, "article:author") ||
      extractMetaTag(html, "twitter:creator");

    // Inspect JSON-LD for duration or metrics if present
    let durationSeconds: number | undefined;
    const jsonLdMatch = html.match(/<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
    if (jsonLdMatch && jsonLdMatch[1]) {
      try {
        const parsedJson = JSON.parse(jsonLdMatch[1]) as Record<string, unknown>;
        if (typeof parsedJson.duration === "string") {
          durationSeconds = parseIsoDuration(parsedJson.duration);
        }
      } catch {
        // Ignore JSON-LD parse errors
      }
    }

    return {
      platform: "other",
      url: rawUrl,
      title,
      caption,
      thumbnailUrl,
      videoUrl,
      authorName,
      durationSeconds,
      extractedAt: now,
    };
  } catch (err) {
    return {
      platform: "other",
      url: rawUrl,
      extractedAt: now,
      rawPayload: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

// ---------------------------------------------------------------------------
// Universal Router
// ---------------------------------------------------------------------------

/**
 * Universal router to scrape any social media URL across all platforms.
 */
export async function scrapeSocialUrl(url: string): Promise<ScrapedSocialPost> {
  const lower = url.toLowerCase();

  if (lower.includes("instagram.com")) {
    return scrapeInstagramPost(url);
  }
  if (lower.includes("tiktok.com")) {
    return scrapeTikTokPost(url);
  }
  if (lower.includes("youtube.com") || lower.includes("youtu.be")) {
    return scrapeYouTubeShort(url);
  }
  if (lower.includes("twitter.com") || lower.includes("x.com")) {
    return scrapeTwitterPost(url);
  }
  if (lower.includes("threads.net")) {
    return scrapeThreadsPost(url);
  }
  if (lower.includes("facebook.com") || lower.includes("fb.watch")) {
    return scrapeFacebookPost(url);
  }
  if (lower.includes("pinterest.com") || lower.includes("pin.it")) {
    return scrapePinterestPost(url);
  }
  if (lower.includes("reddit.com") || lower.includes("redd.it")) {
    return scrapeRedditPost(url);
  }
  if (lower.includes("linkedin.com")) {
    return scrapeLinkedInPost(url);
  }

  return scrapeUniversalUrl(url);
}
