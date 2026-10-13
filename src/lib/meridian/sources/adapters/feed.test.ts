import assert from "node:assert/strict";
import test from "node:test";
import { FEED_NOT_CONNECTED, FeedSourceAdapter } from "./feed.ts";
import { V2exSourceAdapter } from "./v2ex.ts";

const CONFIG = { url: "http://127.0.0.1:8765", token: "test-token-0123456789abcdef" };
const FEED_XML = "<rss><channel><title>News</title><item><title>One</title><link>https://a.test/1</link></item></channel></rss>";

function sidecarReturning(body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
}

test("with no sidecar, the feed adapter reads nothing and reports that it is not connected", async () => {
  const adapter = new FeedSourceAdapter({ config: null });
  assert.equal((await adapter.health()).status, "NOT_CONFIGURED");
  await assert.rejects(() => adapter.discover({ query: "https://a.test/feed.xml" }), (error: Error) => error.message === FEED_NOT_CONNECTED);
});

test("a feed address becomes one reference per item, each pointing at its article", async () => {
  const adapter = new FeedSourceAdapter({
    config: CONFIG,
    fetchFeed: async () => ({ url: "https://a.test/feed.xml", feed: FEED_XML }),
    fetchImpl: sidecarReturning({ feedTitle: "News", items: [{ title: "One", link: "https://a.test/1", published: "", summary: "" }] }),
  });
  const refs = await adapter.discover({ query: "https://a.test/feed.xml", limit: 5 });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].platform, "rss");
  assert.equal(refs[0].canonicalUrl, "https://a.test/1");
  assert.equal(refs[0].metadata?.feedTitle, "News");
});

test("an empty query reads nothing, and a private address is refused before any fetch", async () => {
  const adapter = new FeedSourceAdapter({ config: CONFIG, fetchFeed: async () => { throw new Error("must not fetch"); } });
  assert.deepEqual(await adapter.discover({ query: "   " }), []);
  await assert.rejects(() => adapter.discover({ query: "http://127.0.0.1/feed" }), /public http or https URL/);
});

test("V2EX refuses free text that is not a node name, and reads a node when given one", async () => {
  const adapter = new V2exSourceAdapter({
    config: CONFIG,
    fetchImpl: sidecarReturning({ items: [{ title: "T", url: "https://www.v2ex.com/t/9", replies: 2 }] }),
  });
  await assert.rejects(() => adapter.discover({ query: "buy now!!" }), /node name/);
  const refs = await adapter.discover({ query: "python", limit: 3 });
  assert.equal(refs[0].platform, "v2ex");
  assert.equal(refs[0].metadata?.node, "python");
  assert.equal((await new V2exSourceAdapter({ config: null }).health()).status, "NOT_CONFIGURED");
});
