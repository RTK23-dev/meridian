// Apify Instagram discovery: input shapes, the reading of items, the median and the client's answers. Pure: no database and no
// request. Items come from fixtures built from the documented shapes (fixtures.ts), not from live responses.

import assert from "node:assert/strict";
import test from "node:test";
import type { ApifyGateway } from "./client.ts";
import { gatewayApifyClient, notConnectedApifyClient, settleApifyResponse } from "./client.ts";
import { INSTAGRAM_VOLUME_CONFIG } from "./config.ts";
import { ACTORS, creatorReelSet, hashtagReelItem, HASHTAG_PHOTO_ITEM, UNREADABLE_ITEM } from "./fixtures.ts";
import {
  type ReelCandidate,
  creatorBaseline,
  creatorReelsInput,
  hashtagInput,
  medianOf,
  nicheHashtags,
  parseReelItem,
  reelKey,
  reelUrlInput,
  sameCreator,
  VIEWS_METRIC,
} from "./instagram-volume.ts";

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

test("the niche becomes hashtags: spaces are removed, separators split terms, duplicates and extra terms are dropped", () => {
  assert.deepEqual(nicheHashtags("skin care, Hair Tips"), ["skincare", "hairtips"]);
  assert.deepEqual(nicheHashtags("#skincare #haircare"), ["skincare", "haircare"]);
  assert.deepEqual(nicheHashtags("skincare, skincare, SkinCare"), ["skincare"]);
  assert.deepEqual(nicheHashtags("  ,, !!  "), []);
  assert.equal(nicheHashtags("a1, b2, c3, d4, e5, f6, g7").length, INSTAGRAM_VOLUME_CONFIG.maxHashtagsPerRun);
});

test("the actor inputs carry only the fields the docs name", () => {
  assert.deepEqual(hashtagInput("skincare", 200), { hashtags: ["skincare"], resultsType: "posts", resultsLimit: 200 });
  assert.deepEqual(creatorReelsInput("creator_a", 30), { username: ["creator_a"], resultsLimit: 30, skipPinnedPosts: true });
  assert.deepEqual(reelUrlInput("https://www.instagram.com/reel/ABC/"), { username: ["https://www.instagram.com/reel/ABC/"], resultsLimit: 1 });
  assert.equal(VIEWS_METRIC, "videoPlayCount");
});

test("a reel item is read with its counts; a hidden like count (-1) and a missing view count are null, never 0", () => {
  const reel = parseReelItem(hashtagReelItem(1));
  assert.ok(reel);
  assert.equal(reel.permalink, "https://www.instagram.com/reel/FIXTURE_H1/");
  assert.equal(reel.creatorHandle, "fixture_creator_a");
  assert.equal(reel.externalId, "fixture-hashtag-1");
  assert.equal(reel.views, 12100);
  assert.equal(reel.likes, null, "likesCount -1 means the creator hid the count");
  assert.equal(reel.comments, 85);
  assert.equal(reel.postedAt, "2026-10-10T09:00:00.000Z");
  assert.deepEqual(reel.hashtags, ["skincare"]);
  assert.equal(reel.isVideo, true);

  const noViews = parseReelItem({ ...hashtagReelItem(2), videoPlayCount: undefined });
  assert.equal(noViews?.views, null);
  const negative = parseReelItem({ ...hashtagReelItem(3), videoPlayCount: -4 });
  assert.equal(negative?.views, null);
});

test("an item that is not a reel, has no Instagram link or no owner is not read as a candidate", () => {
  const photo = parseReelItem(HASHTAG_PHOTO_ITEM);
  assert.ok(photo, "a photo is still a readable item");
  assert.equal(photo.isVideo, false, "but it is not a video, so the gather does not keep it");
  assert.equal(parseReelItem(UNREADABLE_ITEM), null, "a link off Instagram is refused");
  assert.equal(parseReelItem({ ...hashtagReelItem(4), ownerUsername: "   " }), null);
  assert.equal(parseReelItem({ ...hashtagReelItem(5), url: "http://www.instagram.com/reel/X/" }), null, "only https");
  assert.equal(parseReelItem("not an object"), null);
  assert.equal(parseReelItem(null), null);
  assert.equal(parseReelItem([]), null);
});

test("a bad timestamp is null, and hashtags keep only letters, digits and underscores", () => {
  const reel = parseReelItem({ ...hashtagReelItem(6), timestamp: "last tuesday", hashtags: ["#Good_tag", "bad tag!", 7, "ok"] });
  assert.equal(reel?.postedAt, null);
  assert.deepEqual(reel?.hashtags, ["good_tag", "ok"]);
});

test("the id falls back to the shortcode, and a numeric id is kept as text", () => {
  assert.equal(parseReelItem({ ...hashtagReelItem(7), id: undefined, shortCode: "SHORT_7" })?.externalId, "SHORT_7");
  assert.equal(parseReelItem({ ...hashtagReelItem(8), id: 12345 })?.externalId, "12345");
});

test("the median is of whole numbers, rounded half up, and null for no values", () => {
  assert.equal(medianOf([]), null);
  assert.equal(medianOf([5]), 5);
  assert.equal(medianOf([1, 3, 2]), 2);
  assert.equal(medianOf([1, 2]), 2, "1.5 rounds to 2 because a view count is stored as a whole number");
  assert.equal(medianOf([3, 9, 1, 7]), 5);
});

test("a creator's baseline needs ten reels with a view count, counts only that creator's reels, and never a zero median", () => {
  const mine = creatorReelSet("creator_a", [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000]).map((raw) => parseReelItem(raw));
  const reels = mine.filter((reel): reel is NonNullable<typeof reel> => reel !== null);
  const other = creatorReelSet("creator_b", [1, 1, 1, 1, 1, 1, 1, 1, 1, 1])
    .map((raw) => parseReelItem(raw))
    .filter((reel): reel is ReelCandidate => reel !== null);

  const measured = creatorBaseline([...reels, ...other], "@Creator_A");
  assert.deepEqual(measured, { status: "measured", median: 6500, sampleSize: 12, reason: "" });

  const few = creatorBaseline(reels.slice(0, 3), "creator_a");
  assert.equal(few.status, "insufficient");
  assert.equal(few.median, null);
  assert.equal(few.sampleSize, 3);
  assert.match(few.reason, /Only 3 of the last 3 reels report a view count; 10 are needed/);

  const none = creatorBaseline(other, "creator_a");
  assert.equal(none.median, null);
  assert.match(none.reason, /returned no reels for @creator_a/);

  const zeros = creatorBaseline(
    creatorReelSet("creator_c", Array.from({ length: 10 }, () => 0))
      .map((raw) => parseReelItem(raw))
      .filter((reel): reel is ReelCandidate => reel !== null),
    "creator_c",
  );
  assert.equal(zeros.median, null, "a zero median would make the ratio undefined");
  assert.match(zeros.reason, /median view count is zero/);
});

test("handles compare without case or @, and one reel has one key however its address is written", () => {
  assert.equal(sameCreator("@Creator_A", "creator_a"), true);
  assert.equal(sameCreator("", ""), false);
  assert.equal(reelKey("https://www.instagram.com/reel/ABC_1/"), reelKey("https://www.instagram.com/p/ABC_1/?utm=x"));
  assert.equal(reelKey("https://www.instagram.com/reel/ABC_1/"), "shortcode:ABC_1");
  assert.match(reelKey("https://www.instagram.com/someone/"), /^address:/);
});

test("an Apify answer is items only for a 200 or 201 with a JSON list; every other answer is failed with a short reason", () => {
  assert.deepEqual(settleApifyResponse(201, encode([{ a: 1 }])), { status: "ok", items: [{ a: 1 }] });
  assert.deepEqual(settleApifyResponse(200, encode([])), { status: "ok", items: [] });
  assert.equal(settleApifyResponse(408, encode({})).status, "failed");
  assert.match(settleApifyResponse(408, encode({})).reason, /time limit/);
  const refused = settleApifyResponse(401, encode({ error: { type: "auth", message: "Token is not valid." } }));
  assert.equal(refused.status, "failed");
  assert.match(refused.reason, /answered 401\. Token is not valid\./);
  assert.equal(settleApifyResponse(402, encode({ error: { message: "x".repeat(400) } })).reason.length < 260, true, "a provider message is cut short");
  assert.match(settleApifyResponse(500, new TextEncoder().encode("<html>")).reason, /answered 500\.$/);
  assert.equal(settleApifyResponse(200, encode({ not: "a list" })).status, "failed");
  assert.equal(settleApifyResponse(200, new TextEncoder().encode("not json")).status, "failed");
});

test("the client sends an authenticated gateway request to the actor's sync endpoint, with the caps as query and body", async () => {
  const seen: Array<{ path: string; body: unknown; timeoutMs?: number; organizationId: string | null }> = [];
  const gateway: ApifyGateway = {
    async call(input) {
      seen.push({ path: input.path, body: JSON.parse(String(input.body)), timeoutMs: input.timeoutMs, organizationId: input.organizationId });
      return { status: "ok", response: { status: 201, headers: {}, body: encode([hashtagReelItem(1)]) } };
    },
    async connection() {
      return { connected: true, reason: null };
    },
  };
  const client = gatewayApifyClient(async () => gateway);

  const answer = await client.runSync({
    organizationId: "org-1",
    actorId: ACTORS.niche,
    input: hashtagInput("skincare", 200),
    maxItems: 200,
  });
  assert.equal(answer.status, "ok");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.path, "/actors/apify~instagram-hashtag-scraper/run-sync-get-dataset-items?maxItems=200&timeout=300");
  assert.deepEqual(seen[0]?.body, hashtagInput("skincare", 200));
  assert.equal(seen[0]?.timeoutMs, INSTAGRAM_VOLUME_CONFIG.transportTimeoutMs);
  assert.equal(seen[0]?.organizationId, "org-1");
});

test("the client reports not connected from the gateway, a thrown error as a generic failure, and sends nothing for a zero cap", async () => {
  const gateway: ApifyGateway = {
    async call() {
      throw new Error("socket hang up with token=secret-value");
    },
    async connection() {
      return { connected: false, reason: "No Apify key." };
    },
  };
  const client = gatewayApifyClient(async () => gateway);

  assert.deepEqual(await client.connection("org-1"), { connected: false, reason: "No Apify key." });
  const thrown = await client.runSync({ organizationId: "org-1", actorId: ACTORS.creator, input: {}, maxItems: 5 });
  assert.deepEqual(thrown, { status: "failed", reason: "The request to Apify did not complete." }, "the thrown text is not repeated");

  const zero = await client.runSync({ organizationId: "org-1", actorId: ACTORS.creator, input: {}, maxItems: 0 });
  assert.equal(zero.status, "failed");
});

test("a gateway that reports not connected becomes a not connected answer, and the fallback client never sends", async () => {
  const gateway: ApifyGateway = {
    async call() {
      return { status: "not_connected", reason: "Apify has no key." };
    },
    async connection() {
      return { connected: false, reason: "Apify has no key." };
    },
  };
  const answer = await gatewayApifyClient(async () => gateway).runSync({
    organizationId: "org-1",
    actorId: ACTORS.creator,
    input: {},
    maxItems: 1,
  });
  assert.deepEqual(answer, { status: "not_connected", reason: "Apify has no key." });

  const fallback = notConnectedApifyClient("Not set up.");
  assert.deepEqual(await fallback.connection("org-1"), { connected: false, reason: "Not set up." });
  assert.deepEqual(await fallback.runSync({ organizationId: "org-1", actorId: ACTORS.creator, input: {}, maxItems: 1 }), {
    status: "not_connected",
    reason: "Not set up.",
  });
});
