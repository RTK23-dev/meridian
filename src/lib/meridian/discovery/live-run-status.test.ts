/**
 * The status a run records for a keyed source that answers with a live response: a rate limit or a rejected key is recorded
 * with the run, a connected source that returns videos is stored with its provenance, and a source that finds nothing ran. The
 * provider is an injected fetch, so no test makes a network request.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { withEnv } from "../../../test-support/lib/meridian/credentials/test-databases.ts";
import { studioTenant } from "../../../test-support/lib/meridian/testing/durable-image-fixtures.ts";
import { saveWorkspaceProviderConfig } from "../settings/provider-config.ts";
import { getSql } from "../../db.ts";
import { SourceRegistry } from "../sources/registry.ts";
import { YouTubeSourceAdapter } from "../sources/adapters/youtube.ts";
import type { SourceFetch } from "../sources/live-api.ts";
import type { SourceAdapter } from "../sources/types.ts";
import { DiscoveryService, type PageCrawler } from "./service.ts";
import { crawlLadderPage } from "./crawler.ts";

// Used only by this test process: the vault encrypts saved keys with this master key.
process.env.TOKEN_ENCRYPTION_KEY = "test-encryption-key-for-live-run-status";

/** The deployment variables a keyed source could fall back to. Cleared so only a key saved for the test workspace is used. */
const NO_DEPLOYMENT_KEYS = {
  YOUTUBE_API_KEY: undefined,
  YOUTUBE_SHARED_DEFAULT: undefined,
  SERPAPI_API_KEY: undefined,
  SEARCH_SHARED_DEFAULT: undefined,
  META_AD_LIBRARY_TOKEN: undefined,
  META_AD_LIBRARY_SHARED_DEFAULT: undefined,
};

/** Fixture: YouTube Data API v3 search.list with two videos, reduced to the fields the adapter reads. */
const YOUTUBE_SEARCH = {
  kind: "youtube#searchListResponse",
  items: [
    { kind: "youtube#searchResult", id: { kind: "youtube#video", videoId: "aB3dE5fG7hI" }, snippet: { publishedAt: "2026-09-02T10:15:00Z", title: "Mesh sponge demo" } },
    { kind: "youtube#searchResult", id: { kind: "youtube#video", videoId: "zY9xW8vU7tS" }, snippet: { publishedAt: "2026-09-03T08:00:00Z", title: "Second video" } },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fixedFetch(respond: () => Response): SourceFetch {
  return async () => respond();
}

/** A registry with only the given keyed adapter registered, so the other sources are planned as not configured. */
function registryWith(adapter: SourceAdapter): SourceRegistry {
  const registry = new SourceRegistry();
  registry.register(adapter);
  return registry;
}

/** A workspace with a YouTube key saved for it, and a tenant for the brand the run is stored under. */
async function tenantWithYouTubeKey(label: string, key: string) {
  const sql = await getSql();
  const tenant = await studioTenant(sql, label);
  await saveWorkspaceProviderConfig(sql, {
    organizationId: tenant.organizationId,
    actorId: tenant.userId,
    category: "youtube",
    credentials: { apiKey: key },
  });
  return { ...tenant, sql };
}

test("a keyed source that is rate limited is recorded with its health, and a run where nothing else ran is blocked", async () => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const ws = await tenantWithYouTubeKey("live-run-429", "yt-run-key-1111");
    const service = new DiscoveryService(registryWith(new YouTubeSourceAdapter({ fetch: fixedFetch(() => json({}, 429)) })));
    const { run, items } = await service.startDiscoveryRun({
      organizationId: ws.organizationId, brandId: ws.brandId, scope: "niche", seeds: ["mesh sponge"], sql: ws.sql,
    });

    assert.equal(run.status, "blocked", "no source ran: the only source that was called failed");
    assert.equal(items.length, 0);
    const youtube = run.progress.sources?.find((state) => state.adapterId === "youtube");
    assert.ok(youtube && youtube.status === "failed");
    assert.equal(youtube.sourceStatus, "RATE_LIMITED", "the provider health is recorded with the run");
    assert.match(youtube.reason, /rate limited/);
    assert.equal(run.perSourceErrors.youtube, youtube.reason);
  });
});

test("a connected source that returns videos stores them with its provenance, and the run is completed", async () => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const ws = await tenantWithYouTubeKey("live-run-ok", "yt-run-key-2222");
    const service = new DiscoveryService(registryWith(new YouTubeSourceAdapter({ fetch: fixedFetch(() => json(YOUTUBE_SEARCH)) })));
    const { run, items } = await service.startDiscoveryRun({
      organizationId: ws.organizationId, brandId: ws.brandId, scope: "niche", seeds: ["mesh sponge"], sql: ws.sql,
    });

    assert.equal(run.status, "completed");
    assert.equal(items.length, 2);
    const youtube = run.progress.sources?.find((state) => state.adapterId === "youtube");
    assert.ok(youtube && youtube.status === "ran" && youtube.itemsFound === 2 && youtube.sourceStatus === "CONFIGURED");
    const rows = await ws.sql<{ adapter_id: string; canonical_url: string }>`
      select adapter_id, canonical_url from discovered_items where run_id = ${run.id} order by canonical_url
    `;
    assert.deepEqual(rows.map((row) => row.adapter_id), ["youtube", "youtube"]);
  });
});

test("a connected source that finds nothing ran, so the run is completed with zero items and no invented result", async () => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const ws = await tenantWithYouTubeKey("live-run-empty", "yt-run-key-3333");
    const service = new DiscoveryService(registryWith(new YouTubeSourceAdapter({ fetch: fixedFetch(() => json({ items: [] })) })));
    const { run, items } = await service.startDiscoveryRun({
      organizationId: ws.organizationId, brandId: ws.brandId, scope: "niche", seeds: ["no such phrase"], sql: ws.sql,
    });

    assert.equal(run.status, "completed", "a source ran and returned zero results");
    assert.equal(items.length, 0);
    const youtube = run.progress.sources?.find((state) => state.adapterId === "youtube");
    assert.ok(youtube && youtube.status === "ran" && youtube.itemsFound === 0);
  });
});

test("a connected keyed source is not searched for a seed that names a page: it is listed as not supported, and no request is made", async () => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    const ws = await tenantWithYouTubeKey("live-run-page-seed", "yt-run-key-4444");
    const page = "https://shop.example/sponge";
    const html = `<!doctype html><html><head><title>Sponge</title><meta name="description" content="One page."></head>
      <body><div class="feed"><article class="feed-item card"><h3>Launch week</h3><p>Pre-order today.</p></article></div></body></html>`;
    const requests: string[] = [];
    const youtubeCalls: string[] = [];
    const crawl = ((url: string, runId: string, allowedHosts?: string[]) => crawlLadderPage(url, runId, allowedHosts, {
      fetchHtml: async (target: string) => {
        requests.push(target);
        return { url: target, html };
      },
    })) as PageCrawler;
    const youtube = new YouTubeSourceAdapter({
      fetch: async (url) => {
        youtubeCalls.push(url);
        return json(YOUTUBE_SEARCH);
      },
    });
    const service = new DiscoveryService(registryWith(youtube), crawl);

    const { run } = await service.startDiscoveryRun({
      organizationId: ws.organizationId, brandId: ws.brandId, scope: "url_list", seeds: [page], sql: ws.sql,
    });

    assert.deepEqual(requests, [page], "the page is read once");
    assert.deepEqual(youtubeCalls, [], "no YouTube search request is made for a page");
    const state = run.progress.sources?.find((source) => source.adapterId === "youtube");
    assert.ok(state && state.status === "not_supported", "the keyed source is listed, not dropped");
    assert.match(state.reason, /names a page/);
    assert.equal(run.status, "completed", "the page ran, and nothing failed");
  });
});
