import assert from "node:assert/strict";
import test from "node:test";
import { listOrganicPosts } from "./service.ts";
import type { Sql } from "../learning/store.ts";

/** A stub database that answers the one query listOrganicPosts makes, with the rows given. */
function postsDatabase(rows: Array<Record<string, unknown>>): Sql {
  return (async () => rows) as unknown as Sql;
}

const BASE_ROW = {
  id: "post-1",
  creative_id: "creative-1",
  platform: "instagram",
  external_id: "ext-1",
  post_url: "",
  caption: "",
  title: "",
  status: "published",
  scheduled_for: null,
  published_at: "2026-10-01T00:00:00Z",
  created_at: "2026-10-01T00:00:00Z",
};

test("a metric the platform never reported is null, not zero", async () => {
  const [post] = await listOrganicPosts(
    postsDatabase([{ ...BASE_ROW, views: null, three_second_views: null, completion_rate: null, shares: null, likes: null }]),
    "org-1",
    "brand-1",
  );
  assert.equal(post?.views, null);
  assert.equal(post?.threeSecondViews, null);
  assert.equal(post?.completionRate, null);
  assert.equal(post?.shares, null);
  assert.equal(post?.likes, null);
});

test("a metric the platform reported as zero stays zero, and numeric text is read as a number", async () => {
  const [post] = await listOrganicPosts(
    postsDatabase([{ ...BASE_ROW, views: 0, three_second_views: "340", completion_rate: 0, shares: null, likes: 12 }]),
    "org-1",
    "brand-1",
  );
  assert.equal(post?.views, 0);
  assert.equal(post?.threeSecondViews, 340);
  assert.equal(post?.completionRate, 0);
  assert.equal(post?.shares, null);
  assert.equal(post?.likes, 12);
});

test("a post with no observation at all has null metrics, not a row of zeros", async () => {
  const posts = await listOrganicPosts(postsDatabase([{ ...BASE_ROW, views: null, three_second_views: null, completion_rate: null, shares: null, likes: null }]), "org-1", "brand-1");
  assert.equal(posts.length, 1);
  assert.deepEqual([posts[0]?.views, posts[0]?.likes], [null, null]);
});
