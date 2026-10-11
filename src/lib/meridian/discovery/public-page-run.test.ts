/**
 * A discovery run over public pages only, end to end: the run row, the fetched page, its discovered items and evidence with
 * their provenance, the source row, the dedupe across runs and brands, and each source's own state. Every page is served by
 * an injected fetch, so no test makes a network request.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { crawlLadderPage } from "./crawler.ts";
import { sourceProvenance } from "./provenance.ts";
import { sourceExternalId } from "./source-identity.ts";
import { DiscoveryService, type PageCrawler } from "./service.ts";

const SPONGE = "https://shop.example/sponge";

/** A product page: an Open Graph and JSON-LD declaration, a meta description, and one repeated card. */
function spongePage(options: { description?: string; canonical?: string } = {}): string {
  const description = options.description ?? "Antibacterial mesh sponge for kitchens.";
  const canonical = options.canonical ?? SPONGE;
  return `<!doctype html><html><head>
<title>Mesh sponge</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="Mesh sponge">
<meta property="og:image" content="https://shop.example/sponge.jpg">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Mesh sponge"}</script>
</head><body><div class="feed">
<article class="feed-item card"><h3>Launch week</h3><p>Pre-order today.</p><a href="/launch">Read</a></article>
</div></body></html>`;
}

/** A second page on the same host. It repeats the launch card, and declares a different title and no structured data. */
const BUNDLE = "https://shop.example/bundle";
const bundlePage = `<html><head><title>Bundle</title><meta name="description" content="Three sponges."></head><body>
<div class="feed"><article class="feed-item card"><h3>Launch week</h3><p>Pre-order today.</p><a href="/launch">Read</a></article></div>
</body></html>`;

/** Serves fixed HTML for each URL through the crawl ladder, and records every request. Unknown URLs fail. */
function servedPages(pages: Record<string, string>) {
  const requests: string[] = [];
  const fetchHtml = async (url: string) => {
    requests.push(url);
    const html = pages[url];
    if (html === undefined) throw new Error(`fixture: no page served for ${url}`);
    return { url, html };
  };
  const crawl: PageCrawler = ((url: string, runId: string, allowedHosts?: string[]) =>
    crawlLadderPage(url, runId, allowedHosts, { fetchHtml })) as PageCrawler;
  return { requests, crawl };
}

async function tenant(sql: Sql) {
  const suffix = randomUUID().slice(0, 8);
  const organizationId = `org-pubrun-${suffix}`;
  const brandId = `brand-pubrun-${suffix}`;
  const otherBrandId = `brand-pubrun-b-${suffix}`;
  await sql`insert into organizations (id, name, slug, created_by) values (${organizationId}, ${organizationId}, ${organizationId}, 'test-user')`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${organizationId}, ${brandId}, 'test-user')`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${otherBrandId}, ${organizationId}, ${otherBrandId}, 'test-user')`;
  return { organizationId, brandId, otherBrandId };
}

async function itemsOf(sql: Sql, runId: string) {
  return sql<{ id: string; adapter_id: string; source_status: string; canonical_url: string; content_hash: string }>`
    select id, adapter_id, source_status, canonical_url, content_hash from discovered_items where run_id = ${runId} order by id
  `;
}

async function evidenceOf(sql: Sql, runId: string) {
  return sql<{
    page_url: string; kind: string; adapter_id: string; content_hash: string; source_status: string; run_id: string; observed_at: string;
  }>`
    select page_url, kind, adapter_id, content_hash, source_status, run_id, observed_at
    from discovered_page_evidence where run_id = ${runId} order by kind
  `;
}

function spongeSource(brandId: string, url = SPONGE): string {
  return sourceExternalId({ brandId, itemId: "", canonicalUrl: url });
}

test("a URL-list run over one public page stores the page, its evidence with provenance, and its source row", async () => {
  const sql = await getSql();
  const { organizationId, brandId } = await tenant(sql);
  const pages = servedPages({ [SPONGE]: spongePage() });
  const service = new DiscoveryService(undefined, pages.crawl);

  const { run, items } = await service.startDiscoveryRun({ organizationId, brandId, scope: "url_list", seeds: [SPONGE], sql });

  assert.equal(run.status, "completed");
  assert.deepEqual(pages.requests, [SPONGE], "the page is fetched once, through the injected fetch");
  assert.equal(items.length, 2, "the page item and its repeated card are stored");

  const [durable] = await sql<{ status: string }>`select status from discovery_runs where id = ${run.id}`;
  assert.equal(durable?.status, "completed", "the durable run row finishes with the same status");

  const stored = await itemsOf(sql, run.id);
  assert.equal(stored.length, 2);
  for (const row of stored) {
    assert.equal(row.adapter_id, "website", "an item names the adapter that produced it");
    assert.equal(row.source_status, "HEALTHY", "an item records the source status at fetch time");
    assert.match(row.content_hash, /^[0-9a-f]{64}$/);
  }
  assert.ok(stored.some((row) => row.canonical_url === SPONGE), "the page item carries its canonical URL");

  const evidence = await evidenceOf(sql, run.id);
  assert.deepEqual(evidence.map((row) => row.kind), ["json_ld", "meta", "open_graph"]);
  for (const row of evidence) {
    assert.equal(row.page_url, SPONGE, "evidence records the canonical source URL");
    assert.equal(row.adapter_id, "website");
    assert.equal(row.run_id, run.id, "evidence records the run that stored it");
    assert.equal(row.source_status, "HEALTHY");
    assert.match(row.content_hash, /^[0-9a-f]{64}$/);
    assert.ok(row.observed_at, "evidence records when the page was fetched");
  }

  const [source] = await sql<{ platform: string; canonical_url: string }>`
    select platform, canonical_url from sources where organization_id = ${organizationId} and external_id = ${spongeSource(brandId)}
  `;
  assert.equal(source?.platform, "website");
  assert.equal(source?.canonical_url, SPONGE);
});

test("each source in the run shows its own state: the page ran, and each keyed source is listed with its reason", async () => {
  const sql = await getSql();
  const { organizationId, brandId } = await tenant(sql);
  const service = new DiscoveryService(undefined, servedPages({ [SPONGE]: spongePage() }).crawl);
  const { run } = await service.startDiscoveryRun({ organizationId, brandId, scope: "url_list", seeds: [SPONGE], sql });

  const states = run.progress.sources ?? [];
  const website = states.find((state) => state.adapterId === "website");
  assert.ok(website && website.status === "ran");
  assert.equal(website.itemsFound, 2);

  const instagram = states.find((state) => state.adapterId === "instagram");
  assert.ok(instagram, "a keyed source with no saved key is listed, not dropped");
  assert.equal(instagram.status, "not_configured");
  assert.ok("reason" in instagram && instagram.reason.length > 0, "the reason comes from the credential resolver");
  assert.ok(!states.some((state) => state.status === "ran" && state.adapterId === "instagram"), "a gated source never reports ran");

  assert.match(run.caveat ?? "", /did not run/, "the caveat counts the gated sources next to the stored items");
  assert.ok(states.every((state) => state.status !== "failed"), "no source failed in this run");
});

test("a second run over the same page stores nothing new, and says every record was seen before", async () => {
  const sql = await getSql();
  const { organizationId, brandId } = await tenant(sql);
  const pages = servedPages({ [SPONGE]: spongePage() });
  const service = new DiscoveryService(undefined, pages.crawl);
  const first = await service.startDiscoveryRun({ organizationId, brandId, scope: "url_list", seeds: [SPONGE], sql });

  const second = await service.startDiscoveryRun({ organizationId, brandId, scope: "url_list", seeds: [SPONGE], sql });

  assert.equal(second.run.status, "completed");
  assert.equal(second.items.length, 0, "no item is returned as new");
  assert.equal((await itemsOf(sql, second.run.id)).length, 0, "no duplicate item row is written");
  assert.equal((await evidenceOf(sql, second.run.id)).length, 0, "no duplicate evidence row is written");
  assert.equal(second.run.progress.seenBefore, 5, "three evidence records and two items were matched as seen before");
  assert.match(second.run.caveat ?? "", /already stores/);

  const website = second.run.progress.sources?.find((state) => state.adapterId === "website");
  assert.ok(website && website.status === "ran" && website.itemsFound === 0 && website.seenBefore === 5);

  const provenance = await sourceProvenance(sql, { organizationId, brandId, sourceKey: spongeSource(brandId) });
  assert.deepEqual(provenance.runIds, [first.run.id, second.run.id].sort(), "the source still lists both runs that observed it");
  assert.deepEqual(provenance.observations.map((observation) => observation.seenBefore), [false, true]);
});

test("a page reached through tracking parameters is the same canonical page, so it is not stored again", async () => {
  const sql = await getSql();
  const { organizationId, brandId } = await tenant(sql);
  const first = await new DiscoveryService(undefined, servedPages({ [SPONGE]: spongePage() }).crawl)
    .startDiscoveryRun({ organizationId, brandId, scope: "url_list", seeds: [SPONGE], sql });

  const tracked = `${SPONGE}?utm_source=newsletter`;
  const again = await new DiscoveryService(undefined, servedPages({ [tracked]: spongePage() }).crawl)
    .startDiscoveryRun({ organizationId, brandId, scope: "url_list", seeds: [tracked], sql });

  assert.equal((await evidenceOf(sql, again.run.id)).length, 0, "the declarations match the stored canonical page");
  assert.equal((await itemsOf(sql, again.run.id)).length, 0);
  assert.ok((again.run.progress.seenBefore ?? 0) > 0);
  assert.equal((await itemsOf(sql, first.run.id)).length, 2);
});

test("changed declarations on the same canonical URL are a new version, and only the changed records are stored", async () => {
  const sql = await getSql();
  const { organizationId, brandId } = await tenant(sql);
  await new DiscoveryService(undefined, servedPages({ [SPONGE]: spongePage() }).crawl)
    .startDiscoveryRun({ organizationId, brandId, scope: "url_list", seeds: [SPONGE], sql });

  const changed = await new DiscoveryService(undefined, servedPages({ [SPONGE]: spongePage({ description: "Now in three colours." }) }).crawl)
    .startDiscoveryRun({ organizationId, brandId, scope: "url_list", seeds: [SPONGE], sql });

  assert.deepEqual((await evidenceOf(sql, changed.run.id)).map((row) => row.kind), ["meta"], "only the changed meta declaration is new");
  const stored = await itemsOf(sql, changed.run.id);
  assert.equal(stored.length, 1, "only the page item changed; the unchanged card is seen before");
  assert.equal(stored[0]?.canonical_url, SPONGE);
});

test("an identical repeated card on another page of the same brand is one record, not a second one", async () => {
  const sql = await getSql();
  const { organizationId, brandId } = await tenant(sql);
  const service = new DiscoveryService(undefined, servedPages({ [SPONGE]: spongePage() }).crawl);
  await service.startDiscoveryRun({ organizationId, brandId, scope: "url_list", seeds: [SPONGE], sql });

  const other = new DiscoveryService(undefined, servedPages({ [BUNDLE]: bundlePage }).crawl);
  const { run, items } = await other.startDiscoveryRun({ organizationId, brandId, scope: "url_list", seeds: [BUNDLE], sql });

  assert.equal(items.length, 1, "only the bundle page itself is new");
  assert.equal(items[0]?.canonicalUrl, BUNDLE);
  assert.ok((run.progress.seenBefore ?? 0) >= 1, "the launch card matched a stored item by content hash");
});

test("the same page stored for another brand is stored again, because dedupe is per brand", async () => {
  const sql = await getSql();
  const { organizationId, brandId, otherBrandId } = await tenant(sql);
  const pages = servedPages({ [SPONGE]: spongePage() });
  await new DiscoveryService(undefined, pages.crawl)
    .startDiscoveryRun({ organizationId, brandId, scope: "url_list", seeds: [SPONGE], sql });

  const { run, items } = await new DiscoveryService(undefined, pages.crawl)
    .startDiscoveryRun({ organizationId, brandId: otherBrandId, scope: "url_list", seeds: [SPONGE], sql });

  assert.equal(items.length, 2, "the other brand gets its own page item and card");
  assert.equal((await evidenceOf(sql, run.id)).length, 3, "and its own evidence");
  assert.equal(run.progress.seenBefore, 0);
});

test("a public page that cannot be fetched fails its source with the error, and the run is failed, not completed", async () => {
  const sql = await getSql();
  const { organizationId, brandId } = await tenant(sql);
  const pages = servedPages({});
  const service = new DiscoveryService(undefined, pages.crawl);

  const { run, items } = await service.startDiscoveryRun({ organizationId, brandId, scope: "url_list", seeds: [SPONGE], sql });

  assert.equal(run.status, "failed");
  assert.equal(items.length, 0);
  const website = run.progress.sources?.find((state) => state.adapterId === "website");
  assert.ok(website && website.status === "failed");
  assert.match(website.reason, /no page served for https:\/\/shop\.example\/sponge/, "the failure carries the error, not an empty result");
  assert.equal(run.perSourceErrors[SPONGE], website.reason);
});

test("a free-text niche names no page: no page is fetched, the website state says so, and no source is shown as having run", async () => {
  const sql = await getSql();
  const { organizationId, brandId } = await tenant(sql);
  const pages = servedPages({});
  const service = new DiscoveryService(undefined, pages.crawl);

  const { run, items } = await service.startDiscoveryRun({ organizationId, brandId, scope: "niche", seeds: ["artisan sourdough"], sql });

  assert.deepEqual(pages.requests, [], "no page is fetched for a phrase");
  assert.equal(items.length, 0);
  const website = run.progress.sources?.find((state) => state.adapterId === "website");
  assert.ok(website && website.status === "not_supported");
  assert.match(website.reason, /free text/);
  assert.ok(!(run.progress.sources ?? []).some((state) => state.status === "ran"), "nothing ran");
  assert.match(run.caveat ?? "", /No source ran/);
});
