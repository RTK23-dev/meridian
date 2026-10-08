import assert from "node:assert/strict";
import test from "node:test";
import {
  InstagramBusinessDiscoveryAdapter,
  InstagramHashtagAdapter,
} from "./graph-api-adapter.ts";

test("InstagramBusinessDiscoveryAdapter reports NOT_CONNECTED without credentials", async () => {
  const adapter = new InstagramBusinessDiscoveryAdapter({ credentials: { accessToken: "", businessAccountId: "" } });
  const check = await adapter.checkConnection();
  assert.equal(check.connected, false);

  const fetchRes = await adapter.fetchCreatorReels({ targetUsername: "nike", niche: "fitness" });
  assert.equal(fetchRes.status, "NOT_CONNECTED");
});

test("InstagramBusinessDiscoveryAdapter parses creator media into DiscoveredReelItems", async () => {
  const mockFetch = async (url: string | URL | Request) => {
    const urlStr = url.toString();
    assert.ok(urlStr.includes("business_discovery.username(creatorspotlight)"));

    return new Response(
      JSON.stringify({
        business_discovery: {
          followers_count: 45000,
          media_count: 120,
          media: {
            data: [
              {
                id: "180491823901",
                caption: "3 life changing habits for productivity #habits #routine",
                media_type: "VIDEO",
                like_count: 2400,
                comments_count: 180,
                timestamp: "2026-10-07T12:00:00Z",
                permalink: "https://www.instagram.com/reel/C12345678/",
              },
            ],
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const adapter = new InstagramBusinessDiscoveryAdapter({
    credentials: { accessToken: "EAAG_TEST_TOKEN", businessAccountId: "1784140000000" },
    fetchFn: mockFetch as unknown as typeof fetch,
  });

  const res = await adapter.fetchCreatorReels({ targetUsername: "creatorspotlight", niche: "productivity" });
  assert.equal(res.status, "connected");
  if (res.status !== "connected") return;

  assert.equal(res.items.length, 1);
  const item = res.items[0];
  assert.equal(item.creatorHandle, "creatorspotlight");
  assert.equal(item.creatorFollowerCount, 45000);
  assert.equal(item.externalPostId, "180491823901");
  assert.deepEqual(item.hashtags, ["#habits", "#routine"]);
  assert.equal(item.metrics.likes, 2400);
  assert.equal(item.metrics.comments, 180);
});

test("InstagramHashtagAdapter searches hashtag ID then fetches top reels", async () => {
  const mockFetch = async (url: string | URL | Request) => {
    const urlStr = url.toString();
    if (urlStr.includes("ig_hashtag_search")) {
      return new Response(
        JSON.stringify({ data: [{ id: "1784382910" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (urlStr.includes("/1784382910/top_media")) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "99887766",
              caption: "The ultimate skincarestudy #skincare #glow",
              media_type: "VIDEO",
              like_count: 8500,
              comments_count: 420,
              permalink: "https://www.instagram.com/reel/C98765432/",
              timestamp: "2026-10-06T15:00:00Z",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("Not found", { status: 404 });
  };

  const adapter = new InstagramHashtagAdapter({
    credentials: { accessToken: "EAAG_TEST_TOKEN", businessAccountId: "1784140000000" },
    fetchFn: mockFetch as unknown as typeof fetch,
  });

  const res = await adapter.fetchHashtagTopReels({ hashtag: "skincare", niche: "beauty" });
  assert.equal(res.status, "connected");
  if (res.status !== "connected") return;

  assert.equal(res.items.length, 1);
  const item = res.items[0];
  assert.equal(item.externalPostId, "99887766");
  assert.deepEqual(item.hashtags, ["#skincare", "#glow"]);
  assert.equal(item.metrics.likes, 8500);
  assert.equal(item.metrics.comments, 420);
});
