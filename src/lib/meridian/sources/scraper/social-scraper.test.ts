import assert from "node:assert/strict";
import test from "node:test";
import {
  extractInstagramShortcode,
  extractYouTubeVideoId,
  extractTikTokVideoId,
  extractTwitterStatusId,
  extractThreadsPostId,
  extractFacebookVideoId,
  extractPinterestPinId,
  extractRedditPostId,
  extractLinkedInActivityId,
  scrapeSocialUrl,
} from "./social-scraper.ts";

test("extractInstagramShortcode extracts valid shortcodes from Reels and Posts", () => {
  const reelUrl = "https://www.instagram.com/reel/C123abcXYZ_/?utm_source=ig_web_copy_link";
  assert.equal(extractInstagramShortcode(reelUrl), "C123abcXYZ_");

  const postUrl = "https://instagram.com/p/DFGHjk789/";
  assert.equal(extractInstagramShortcode(postUrl), "DFGHjk789");

  assert.equal(extractInstagramShortcode("https://example.com"), null);
});

test("extractYouTubeVideoId extracts video ID across Shorts, Watch, and youtu.be", () => {
  const shortsUrl = "https://www.youtube.com/shorts/dQw4w9WgXcQ";
  assert.equal(extractYouTubeVideoId(shortsUrl), "dQw4w9WgXcQ");

  const watchUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s";
  assert.equal(extractYouTubeVideoId(watchUrl), "dQw4w9WgXcQ");

  const shareUrl = "https://youtu.be/dQw4w9WgXcQ";
  assert.equal(extractYouTubeVideoId(shareUrl), "dQw4w9WgXcQ");

  assert.equal(extractYouTubeVideoId("https://youtube.com/feed/subscriptions"), null);
});

test("extractTikTokVideoId extracts video ID correctly", () => {
  const url = "https://www.tiktok.com/@creator/video/7123456789012345678?is_copy_url=1";
  assert.equal(extractTikTokVideoId(url), "7123456789012345678");
  assert.equal(extractTikTokVideoId("https://tiktok.com/@user"), null);
});

test("extractTwitterStatusId extracts status and user correctly", () => {
  const url1 = "https://twitter.com/OpenAI/status/1768700000000000000";
  const res1 = extractTwitterStatusId(url1);
  assert.equal(res1?.statusId, "1768700000000000000");
  assert.equal(res1?.user, "OpenAI");

  const url2 = "https://x.com/tech_lead/status/123456789";
  const res2 = extractTwitterStatusId(url2);
  assert.equal(res2?.statusId, "123456789");
  assert.equal(res2?.user, "tech_lead");
});

test("extractThreadsPostId extracts post ID and author", () => {
  const url = "https://www.threads.net/@zuck/post/C_abc123XYZ";
  const res = extractThreadsPostId(url);
  assert.equal(res?.postId, "C_abc123XYZ");
  assert.equal(res?.user, "zuck");
});

test("extractFacebookVideoId extracts ID across reels and watch", () => {
  const reelUrl = "https://www.facebook.com/reel/1029384756";
  assert.equal(extractFacebookVideoId(reelUrl), "1029384756");

  const watchUrl = "https://www.facebook.com/watch/?v=987654321";
  assert.equal(extractFacebookVideoId(watchUrl), "987654321");
});

test("extractPinterestPinId extracts pin numbers", () => {
  const pinUrl = "https://www.pinterest.com/pin/123456789012345678/";
  assert.equal(extractPinterestPinId(pinUrl), "123456789012345678");

  const shortUrl = "https://pin.it/abcd123";
  assert.equal(extractPinterestPinId(shortUrl), "abcd123");
});

test("extractRedditPostId extracts subreddit and post ID", () => {
  const url = "https://www.reddit.com/r/marketing/comments/18xyz99/what_is_the_best_hook_for_ugc/";
  const res = extractRedditPostId(url);
  assert.equal(res?.postId, "18xyz99");
  assert.equal(res?.subreddit, "marketing");
});

test("extractLinkedInActivityId extracts activity or post slug", () => {
  const url = "https://www.linkedin.com/posts/marketing-leader_ugc-creative-strategy-activity-7123456789012345678-abcd";
  assert.equal(extractLinkedInActivityId(url), "marketing-leader_ugc-creative-strategy-activity-7123456789012345678-abcd");
});

test("scrapeSocialUrl routes to appropriate social handlers across all networks", async () => {
  const igResult = await scrapeSocialUrl("https://www.instagram.com/reel/Ctest123/");
  assert.equal(igResult.platform, "instagram");
  assert.equal(igResult.externalId, "Ctest123");

  const ytResult = await scrapeSocialUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ");
  assert.equal(ytResult.platform, "youtube");
  assert.equal(ytResult.externalId, "dQw4w9WgXcQ");

  const ttResult = await scrapeSocialUrl("https://www.tiktok.com/@creator/video/1234567890");
  assert.equal(ttResult.platform, "tiktok");
  assert.equal(ttResult.externalId, "1234567890");

  const twResult = await scrapeSocialUrl("https://x.com/creator/status/987654321");
  assert.equal(twResult.platform, "twitter");
  assert.equal(twResult.externalId, "987654321");

  const threadsResult = await scrapeSocialUrl("https://www.threads.net/@creator/post/Cu12345");
  assert.equal(threadsResult.platform, "threads");
  assert.equal(threadsResult.externalId, "Cu12345");

  const fbResult = await scrapeSocialUrl("https://www.facebook.com/reel/1122334455");
  assert.equal(fbResult.platform, "facebook");
  assert.equal(fbResult.externalId, "1122334455");

  const pinResult = await scrapeSocialUrl("https://www.pinterest.com/pin/9988776655/");
  assert.equal(pinResult.platform, "pinterest");
  assert.equal(pinResult.externalId, "9988776655");

  const redditResult = await scrapeSocialUrl("https://www.reddit.com/r/videos/comments/xyz123/cool_clip/");
  assert.equal(redditResult.platform, "reddit");
  assert.equal(redditResult.externalId, "xyz123");

  const liResult = await scrapeSocialUrl("https://www.linkedin.com/posts/acme_update-12345");
  assert.equal(liResult.platform, "linkedin");
  assert.equal(liResult.externalId, "acme_update-12345");
});
