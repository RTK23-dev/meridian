/**
 * The keyed sources (YouTube, SerpAPI, Meta Ad Library) call their provider through an injected fetch. The fixtures mirror the
 * public response shapes of each API, reduced to the fields the adapters read, and they include the fields the adapters must
 * not store. No test makes a network request: every adapter here is given a recording transport, and a call that reached the
 * platform fetch would fail the test.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import { withEnv } from "../credentials/test-databases.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { saveWorkspaceProviderConfig, type ProviderCategory } from "../settings/provider-config.ts";
import { normalizeCanonicalUrl } from "../evidence/dedupe.ts";
import { SourceCallError, type SourceFetch } from "./live-api.ts";
import { YouTubeSourceAdapter } from "./adapters/youtube.ts";
import { SearchSourceAdapter } from "./adapters/search.ts";
import { MetaAdLibrarySourceAdapter } from "./adapters/meta-ad-library.ts";

// Used only by this test process: the vault encrypts saved keys with this master key.
process.env.TOKEN_ENCRYPTION_KEY = "test-encryption-key-for-live-sources";

/** The deployment variables a keyed source could fall back to. Cleared so only a key saved for the test workspace is used. */
const NO_DEPLOYMENT_KEYS = {
  YOUTUBE_API_KEY: undefined,
  YOUTUBE_SHARED_DEFAULT: undefined,
  SERPAPI_API_KEY: undefined,
  SEARCH_SHARED_DEFAULT: undefined,
  META_AD_LIBRARY_TOKEN: undefined,
  META_AD_LIBRARY_SHARED_DEFAULT: undefined,
};

type Recorded = { url: string; headers: Record<string, string> };

/** A transport that answers every call with `respond`, and records each request URL and header. It never reaches the network. */
function recordingFetch(respond: (url: string) => Response | Error): { fetch: SourceFetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetch: SourceFetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const answer = respond(url);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Fixture: YouTube Data API v3 search.list (part=snippet, type=video). The description and thumbnails are not stored. */
const YOUTUBE_SEARCH = {
  kind: "youtube#searchListResponse",
  etag: "fixture-etag-youtube",
  regionCode: "US",
  pageInfo: { totalResults: 2, resultsPerPage: 2 },
  items: [
    {
      kind: "youtube#searchResult",
      etag: "fixture-etag-1",
      id: { kind: "youtube#video", videoId: "aB3dE5fG7hI" },
      snippet: {
        publishedAt: "2026-09-02T10:15:00Z",
        channelId: "UCfixture0000000000000001",
        title: "Mesh sponge demo",
        description: "Full description text that must not be stored.",
        thumbnails: { default: { url: "https://i.ytimg.com/vi/aB3dE5fG7hI/default.jpg" } },
        channelTitle: "Shop",
        liveBroadcastContent: "none",
        publishTime: "2026-09-02T10:15:00Z",
      },
    },
    {
      kind: "youtube#searchResult",
      etag: "fixture-etag-2",
      id: { kind: "youtube#video", videoId: "zY9xW8vU7tS" },
      snippet: { publishedAt: "not-a-date", title: "Second video", channelTitle: "Other", liveBroadcastContent: "none" },
    },
  ],
};

/** Fixture: SerpAPI search.json for engine=google. Two links are the same page once tracking and the slash are removed. */
const SERPAPI_SEARCH = {
  search_metadata: { id: "fixture-search", status: "Success" },
  search_parameters: { engine: "google", q: "mesh sponge" },
  organic_results: [
    { position: 1, title: "Mesh sponge - Shop", link: "https://shop.example/sponge?utm_source=fixture", displayed_link: "shop.example › sponge", snippet: "Antibacterial mesh sponge." },
    { position: 2, title: "Mesh sponge again", link: "https://shop.example/sponge/", displayed_link: "shop.example › sponge", snippet: "Same page." },
    { position: 3, title: "Not a web link", link: "javascript:alert(1)", snippet: "Must be skipped." },
    { position: 4, title: "Independent review", link: "https://reviews.example/mesh-sponge", date: "Sep 1, 2026", snippet: "A review." },
  ],
};

/** Fixture: Meta Ad Library ads_archive. The paging link carries an access token, which must never be followed or stored. */
const META_ADS_ARCHIVE = {
  data: [
    { id: "1234567890123456", page_name: "Shop", ad_delivery_start_time: "2026-08-01T00:00:00+0000" },
    { id: "2234567890123457", page_name: "Shop", ad_delivery_start_time: "2026-08-05T00:00:00+0000" },
  ],
  paging: {
    cursors: { before: "fixture-before", after: "fixture-after" },
    next: "https://graph.facebook.com/v21.0/ads_archive?after=fixture-after&access_token=FIXTURE-SECRET-TOKEN",
  },
};

/** A workspace with its own saved key for one source category. Each test gets a fresh workspace. */
async function workspaceWithKey(label: string, category: ProviderCategory | null, key: string) {
  const sql = await getSql();
  const tenant = await studioTenant(sql, label);
  if (category) {
    await saveWorkspaceProviderConfig(sql, {
      organizationId: tenant.organizationId,
      actorId: tenant.userId,
      category,
      credentials: { apiKey: key },
    });
  }
  return { ...tenant, sql };
}

async function expectCall(promise: Promise<unknown>, failure: SourceCallError["failure"], secret: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof SourceCallError, `expected a SourceCallError, got ${String(error)}`);
    assert.equal(error.failure, failure);
    assert.ok(!error.message.includes(secret), "the message never carries the key");
    assert.ok(!/googleapis|serpapi\.com|graph\.facebook/.test(error.message), "the message never carries the request URL");
    return true;
  });
}

// --- YouTube ----------------------------------------------------------------------------------------------------------------

test("YouTube: a search maps each video to a reference with its canonical URL, id, title and publish time, and stores nothing else", async () => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const ws = await workspaceWithKey("live-yt-map", "youtube", "yt-workspace-key-1111");
    const transport = recordingFetch(() => json(YOUTUBE_SEARCH));
    const adapter = new YouTubeSourceAdapter({ fetch: transport.fetch });

    const refs = await adapter.discover({ organizationId: ws.organizationId, query: "mesh sponge", limit: 5, since: "2026-08-01T00:00:00Z" });

    assert.equal(transport.calls.length, 1, "one search request");
    const url = new URL(transport.calls[0].url);
    assert.equal(url.origin + url.pathname, "https://www.googleapis.com/youtube/v3/search");
    assert.equal(url.searchParams.get("q"), "mesh sponge");
    assert.equal(url.searchParams.get("type"), "video");
    assert.equal(url.searchParams.get("maxResults"), "5");
    assert.equal(url.searchParams.get("key"), "yt-workspace-key-1111", "the workspace's saved key is used");
    assert.equal(url.searchParams.get("publishedAfter"), "2026-08-01T00:00:00.000Z");

    assert.equal(refs.length, 2);
    const [first, second] = refs;
    assert.equal(first.sourceId, "yt_aB3dE5fG7hI");
    assert.equal(first.platform, "youtube");
    assert.equal(first.externalId, "aB3dE5fG7hI");
    assert.equal(first.canonicalUrl, "https://www.youtube.com/watch?v=aB3dE5fG7hI");
    assert.equal(first.sourceAdapter, "youtube");
    assert.ok(!Number.isNaN(Date.parse(first.discoveredAt)), "the discovery time is recorded");
    assert.deepEqual(first.metadata, { title: "Mesh sponge demo", publishedAt: "2026-09-02T10:15:00.000Z" });
    assert.equal(second.metadata?.publishedAt, undefined, "an unreadable publish time is left out, not invented");

    const stored = JSON.stringify(refs);
    assert.ok(!stored.includes("Full description text"), "the description is not stored");
    assert.ok(!stored.includes("i.ytimg.com"), "thumbnails are not stored");
    assert.ok(!stored.includes("channelTitle") && !stored.includes("Shop\""), "channel details are not stored");
  });
});

test("YouTube: zero results is an empty list, and a result without a video id is skipped rather than invented", async () => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const ws = await workspaceWithKey("live-yt-empty", "youtube", "yt-workspace-key-2222");
    const empty = new YouTubeSourceAdapter({ fetch: recordingFetch(() => json({ kind: "youtube#searchListResponse", items: [] })).fetch });
    assert.deepEqual(await empty.discover({ organizationId: ws.organizationId, query: "no such phrase" }), []);

    const partial = new YouTubeSourceAdapter({
      fetch: recordingFetch(() => json({ items: [{ id: {}, snippet: { title: "No id" } }, { id: { videoId: "aB3dE5fG7hI" } }] })).fetch,
    });
    const refs = await partial.discover({ organizationId: ws.organizationId, query: "x" });
    assert.deepEqual(refs.map((ref) => ref.externalId), ["aB3dE5fG7hI"]);
  });
});

test("YouTube: a response without an items list is not read as zero results", async () => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const ws = await workspaceWithKey("live-yt-malformed", "youtube", "yt-workspace-key-3333");
    const adapter = new YouTubeSourceAdapter({ fetch: recordingFetch(() => json({ kind: "unexpected" })).fetch });
    await expectCall(adapter.discover({ organizationId: ws.organizationId, query: "x" }), "UNAVAILABLE", "yt-workspace-key-3333");
  });
});

test("YouTube: each failure maps to its health, and the message names neither the key nor the URL", async () => {
  const key = "yt-workspace-key-4444";
  const cases: Array<{ name: string; response: () => Response | Error; failure: SourceCallError["failure"] }> = [
    { name: "401", response: () => json({ error: { code: 401, message: "Unauthorized" } }, 401), failure: "AUTH_FAILED" },
    { name: "403 forbidden", response: () => json({ error: { code: 403, errors: [{ reason: "forbidden" }] } }, 403), failure: "AUTH_FAILED" },
    { name: "400 keyInvalid", response: () => json({ error: { code: 400, errors: [{ reason: "keyInvalid" }] } }, 400), failure: "AUTH_FAILED" },
    { name: "403 quotaExceeded", response: () => json({ error: { code: 403, errors: [{ reason: "quotaExceeded" }] } }, 403), failure: "RATE_LIMITED" },
    { name: "429", response: () => json({}, 429), failure: "RATE_LIMITED" },
    { name: "500", response: () => json({}, 500), failure: "UNAVAILABLE" },
    { name: "network error", response: () => new TypeError("fetch failed: connect ECONNREFUSED"), failure: "UNAVAILABLE" },
    { name: "body that is not JSON", response: () => new Response("<html>gateway</html>", { status: 200 }), failure: "UNAVAILABLE" },
  ];
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const ws = await workspaceWithKey("live-yt-errors", "youtube", key);
    for (const testCase of cases) {
      const adapter = new YouTubeSourceAdapter({ fetch: recordingFetch(testCase.response).fetch });
      await expectCall(adapter.discover({ organizationId: ws.organizationId, query: "sponge" }), testCase.failure, key);
    }
  });
});

test("YouTube: without a saved key there is no request, and a key saved for another workspace is never used", async () => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const owner = await workspaceWithKey("live-yt-tenant-a", "youtube", "yt-tenant-a-key-5555");
    const other = await workspaceWithKey("live-yt-tenant-b", null, "");
    const transport = recordingFetch(() => json(YOUTUBE_SEARCH));
    const adapter = new YouTubeSourceAdapter({ fetch: transport.fetch });

    assert.deepEqual(await adapter.discover({ organizationId: other.organizationId, query: "sponge" }), []);
    assert.equal(transport.calls.length, 0, "a workspace with no key makes no request");

    const health = await adapter.health(other.organizationId);
    assert.equal(health.status, "NOT_CONFIGURED");
    assert.ok(health.message && health.message.length > 0, "the reason is shown");

    assert.equal((await adapter.health(owner.organizationId)).status, "CONFIGURED");
    assert.equal(transport.calls.length, 0, "health() is key presence and makes no request");
  });
});

test("YouTube: testConnection makes one request only when asked, and reports the outcome of that request", async () => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const ws = await workspaceWithKey("live-yt-test", "youtube", "yt-workspace-key-6666");
    const ok = recordingFetch(() => json({ items: [] }));
    const healthy = await new YouTubeSourceAdapter({ fetch: ok.fetch }).testConnection(ws.organizationId);
    assert.equal(healthy.status, "HEALTHY");
    assert.equal(ok.calls.length, 1, "exactly one test request");
    assert.match(ok.calls[0].url, /videoCategories/);

    const rejected = recordingFetch(() => json({ error: { code: 401 } }, 401));
    const denied = await new YouTubeSourceAdapter({ fetch: rejected.fetch }).testConnection(ws.organizationId);
    assert.equal(denied.status, "AUTH_FAILED");
    assert.ok(!(denied.message ?? "").includes("yt-workspace-key-6666"));

    const none = recordingFetch(() => json({}));
    const noKey = await new YouTubeSourceAdapter({ fetch: none.fetch }).testConnection(undefined);
    assert.equal(noKey.status, "NOT_CONFIGURED");
    assert.equal(none.calls.length, 0, "no key, no request");
  });
});

// --- SerpAPI ----------------------------------------------------------------------------------------------------------------

test("SerpAPI: results map to canonical references, duplicates collapse, and a non-web link is skipped", async () => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const ws = await workspaceWithKey("live-serp-map", "search", "serp-workspace-key-1111");
    const transport = recordingFetch(() => json(SERPAPI_SEARCH));
    const refs = await new SearchSourceAdapter({ fetch: transport.fetch }).discover({ organizationId: ws.organizationId, query: "mesh sponge", limit: 7 });

    const url = new URL(transport.calls[0].url);
    assert.equal(url.origin + url.pathname, "https://serpapi.com/search.json");
    assert.equal(url.searchParams.get("engine"), "google");
    assert.equal(url.searchParams.get("q"), "mesh sponge");
    assert.equal(url.searchParams.get("num"), "7");
    assert.equal(url.searchParams.get("api_key"), "serp-workspace-key-1111");

    assert.equal(refs.length, 2, "the duplicate page and the javascript link are not references");
    assert.equal(refs[0].canonicalUrl, normalizeCanonicalUrl("https://shop.example/sponge?utm_source=fixture"));
    assert.ok(!refs[0].canonicalUrl?.includes("utm_source"));
    assert.match(refs[0].sourceId, /^serp_[0-9a-f]{16}$/);
    assert.equal(refs[0].sourceAdapter, "search");
    assert.deepEqual(refs[0].metadata, { title: "Mesh sponge - Shop" });
    assert.ok(!JSON.stringify(refs).includes("Antibacterial"), "the snippet is not stored");
  });
});

test("SerpAPI: 'no results' is an empty list, while any other error is a failure", async () => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const ws = await workspaceWithKey("live-serp-empty", "search", "serp-workspace-key-2222");
    const none = new SearchSourceAdapter({ fetch: recordingFetch(() => json({ error: "Google hasn't returned any results for this query." })).fetch });
    assert.deepEqual(await none.discover({ organizationId: ws.organizationId, query: "zzzz" }), []);

    const outOfCredit = new SearchSourceAdapter({ fetch: recordingFetch(() => json({ error: "Your account has run out of searches." })).fetch });
    await expectCall(outOfCredit.discover({ organizationId: ws.organizationId, query: "sponge" }), "UNAVAILABLE", "serp-workspace-key-2222");
  });
});

test("SerpAPI: a rejected key is AUTH_FAILED and a rate limit is RATE_LIMITED, with no key in the message", async () => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const ws = await workspaceWithKey("live-serp-errors", "search", "serp-workspace-key-3333");
    await expectCall(
      new SearchSourceAdapter({ fetch: recordingFetch(() => json({ error: "Invalid API key." }, 401)).fetch }).discover({ organizationId: ws.organizationId, query: "sponge" }),
      "AUTH_FAILED",
      "serp-workspace-key-3333",
    );
    await expectCall(
      new SearchSourceAdapter({ fetch: recordingFetch(() => json({}, 429)).fetch }).discover({ organizationId: ws.organizationId, query: "sponge" }),
      "RATE_LIMITED",
      "serp-workspace-key-3333",
    );
  });
});

test("SerpAPI: no phrase or no key means no request, and testConnection uses the account endpoint", async () => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const ws = await workspaceWithKey("live-serp-gates", "search", "serp-workspace-key-4444");
    const transport = recordingFetch(() => json(SERPAPI_SEARCH));
    const adapter = new SearchSourceAdapter({ fetch: transport.fetch });
    assert.deepEqual(await adapter.discover({ organizationId: ws.organizationId, query: "   " }), []);
    assert.equal(transport.calls.length, 0);

    const other = await workspaceWithKey("live-serp-gates-b", null, "");
    assert.deepEqual(await adapter.discover({ organizationId: other.organizationId, query: "sponge" }), []);
    assert.equal(transport.calls.length, 0, "a workspace without a key makes no request");

    assert.equal((await adapter.health(ws.organizationId)).status, "CONFIGURED");
    assert.equal(transport.calls.length, 0, "health() makes no request");

    const healthy = recordingFetch(() => json({ plan: "free" }));
    assert.equal((await new SearchSourceAdapter({ fetch: healthy.fetch }).testConnection(ws.organizationId)).status, "HEALTHY");
    assert.match(healthy.calls[0].url, /serpapi\.com\/account\.json/);
  });
});

// --- Meta Ad Library --------------------------------------------------------------------------------------------------------

test("Meta Ad Library: ads map to Ad Library references, the token travels in a header, and the paging link is not followed", async () => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const ws = await workspaceWithKey("live-meta-map", "meta_ad_library", "meta-workspace-token-1111");
    const transport = recordingFetch(() => json(META_ADS_ARCHIVE));
    const refs = await new MetaAdLibrarySourceAdapter({ fetch: transport.fetch }).discover({
      organizationId: ws.organizationId, query: "mesh sponge", country: "de", limit: 5,
    });

    assert.equal(transport.calls.length, 1, "the paging link is never followed");
    const url = new URL(transport.calls[0].url);
    assert.equal(url.pathname, "/v21.0/ads_archive");
    assert.equal(url.searchParams.get("search_terms"), "mesh sponge");
    assert.equal(url.searchParams.get("ad_reached_countries"), JSON.stringify(["DE"]));
    assert.equal(url.searchParams.get("limit"), "5");
    assert.ok(!transport.calls[0].url.includes("meta-workspace-token-1111"), "the token is not in the URL");
    assert.equal(transport.calls[0].headers.authorization, "Bearer meta-workspace-token-1111");

    assert.equal(refs.length, 2);
    assert.equal(refs[0].sourceId, "meta_ad_1234567890123456");
    assert.equal(refs[0].externalId, "1234567890123456");
    assert.equal(refs[0].canonicalUrl, "https://www.facebook.com/ads/library/?id=1234567890123456");
    assert.equal(refs[0].platform, "meta_ad_library");
    assert.deepEqual(refs[0].metadata, { title: "Shop", publishedAt: "2026-08-01T00:00:00.000Z" });
    assert.ok(!JSON.stringify(refs).includes("FIXTURE-SECRET-TOKEN"), "no access token is stored");
  });
});

test("Meta Ad Library: an empty archive is an empty list, and a response without an ads list is a failure", async () => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const ws = await workspaceWithKey("live-meta-empty", "meta_ad_library", "meta-workspace-token-2222");
    assert.deepEqual(
      await new MetaAdLibrarySourceAdapter({ fetch: recordingFetch(() => json({ data: [] })).fetch }).discover({ organizationId: ws.organizationId, query: "zzz" }),
      [],
    );
    await expectCall(
      new MetaAdLibrarySourceAdapter({ fetch: recordingFetch(() => json({})).fetch }).discover({ organizationId: ws.organizationId, query: "sponge" }),
      "UNAVAILABLE",
      "meta-workspace-token-2222",
    );
  });
});

test("Meta Ad Library: Graph error codes map to a rejected token, a rate limit, or unavailable", async () => {
  const token = "meta-workspace-token-3333";
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const ws = await workspaceWithKey("live-meta-errors", "meta_ad_library", token);
    const cases: Array<{ response: () => Response; failure: SourceCallError["failure"] }> = [
      { response: () => json({ error: { code: 190, type: "OAuthException", message: "Invalid OAuth access token." } }, 400), failure: "AUTH_FAILED" },
      { response: () => json({ error: { code: 401, message: "Unauthorized" } }, 401), failure: "AUTH_FAILED" },
      { response: () => json({ error: { code: 17, message: "User request limit reached" } }, 400), failure: "RATE_LIMITED" },
      { response: () => json({ error: { code: 1, message: "Unknown error" } }, 500), failure: "UNAVAILABLE" },
    ];
    for (const testCase of cases) {
      const adapter = new MetaAdLibrarySourceAdapter({ fetch: recordingFetch(testCase.response).fetch });
      await expectCall(adapter.discover({ organizationId: ws.organizationId, query: "sponge" }), testCase.failure, token);
    }
  });
});

test("Meta Ad Library: without a saved token there is no request and no ad, and testConnection asks for one ad", async () => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const other = await workspaceWithKey("live-meta-none", null, "");
    const transport = recordingFetch(() => json(META_ADS_ARCHIVE));
    const adapter = new MetaAdLibrarySourceAdapter({ fetch: transport.fetch });
    assert.deepEqual(await adapter.discover({ organizationId: other.organizationId, query: "sponge" }), []);
    assert.equal((await adapter.health(other.organizationId)).status, "NOT_CONFIGURED");
    assert.equal(transport.calls.length, 0);

    const ws = await workspaceWithKey("live-meta-test", "meta_ad_library", "meta-workspace-token-4444");
    const probe = recordingFetch(() => json({ data: [] }));
    assert.equal((await new MetaAdLibrarySourceAdapter({ fetch: probe.fetch }).testConnection(ws.organizationId)).status, "HEALTHY");
    assert.equal(probe.calls.length, 1);
    assert.equal(new URL(probe.calls[0].url).searchParams.get("limit"), "1");
  });
});
