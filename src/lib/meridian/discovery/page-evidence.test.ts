import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { buildPageEvidence, MAX_EVIDENCE_PAYLOAD_BYTES } from "./page-evidence.ts";
import { DiscoveryService, type PageCrawler } from "./service.ts";

type CrawlResult = Awaited<ReturnType<PageCrawler>>;

const jsonLd = [{ "@type": "Product", name: "Mesh sponge", offers: { price: "4.99", priceCurrency: "USD" } }];
const openGraph = { "og:title": "Mesh sponge", "og:image": "https://shop.example/sponge.jpg" };

/** A page that declares structured data. Each URL returns the same declarations. */
const declaringCrawler: PageCrawler = (async (url: string) => ({
  url,
  finalUrl: url,
  title: `Mesh sponge | ${url}`,
  description: "Antibacterial mesh sponge",
  canonicalUrl: url,
  openGraph,
  jsonLd,
  cards: [],
  outboundLinks: [],
}) as unknown as CrawlResult) as PageCrawler;

test("buildPageEvidence keeps each declared kind as its own OBSERVED record and skips empty kinds", () => {
  const evidence = buildPageEvidence({
    title: "Mesh sponge",
    description: "Antibacterial mesh sponge",
    canonicalUrl: "https://shop.example/sponge",
    openGraph,
    jsonLd,
  });
  assert.deepEqual(evidence.map((item) => item.kind), ["json_ld", "open_graph", "meta"]);
  assert.deepEqual(evidence[0]!.payload, { items: jsonLd });
  assert.deepEqual(evidence[1]!.payload, { tags: openGraph });

  const bare = buildPageEvidence({ title: "", description: "", canonicalUrl: "https://shop.example/x", openGraph: {}, jsonLd: [] });
  assert.deepEqual(bare, [], "a page that declares nothing yields no evidence rows");
});

test("an oversized structured payload is recorded as a size marker, not truncated silently into fake data", () => {
  const huge = [{ "@type": "Product", description: "x".repeat(MAX_EVIDENCE_PAYLOAD_BYTES + 1) }];
  const [record] = buildPageEvidence({ title: "", description: "", canonicalUrl: "https://shop.example/x", openGraph: {}, jsonLd: huge });
  assert.equal(record!.kind, "json_ld");
  assert.equal(record!.payload.truncated, true);
  assert.equal(record!.payload.items, undefined, "the oversized content is not stored");
  assert.ok(Number(record!.payload.bytes) > MAX_EVIDENCE_PAYLOAD_BYTES);
});

async function tenant(sql: Sql) {
  const suffix = randomUUID().slice(0, 8);
  const organizationId = `org-pageev-${suffix}`;
  const brandId = `brand-pageev-${suffix}`;
  await sql`insert into organizations (id, name, slug, created_by) values (${organizationId}, ${organizationId}, ${organizationId}, 'test-user')`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${organizationId}, ${brandId}, 'test-user')`;
  return { organizationId, brandId };
}

async function evidenceRows(sql: Sql, runId: string) {
  return sql<{ page_url: string; kind: string; state: string; source_key: string }>`
    select page_url, kind, state, source_key from discovered_page_evidence where run_id = ${runId} order by kind
  `;
}

test("a scraped page's structured data is stored per run, as OBSERVED, linked to its source key", async () => {
  const sql = await getSql();
  const { organizationId, brandId } = await tenant(sql);
  const url = "https://shop.example/sponge";
  const service = new DiscoveryService(undefined, declaringCrawler);
  const first = await service.startDiscoveryRun({ organizationId, brandId, scope: "scrape_page", seeds: [url], sql });
  const rows = await evidenceRows(sql, first.run.id);
  assert.deepEqual(rows.map((row) => row.kind), ["json_ld", "meta", "open_graph"]);
  assert.ok(rows.every((row) => row.state === "OBSERVED" && row.page_url === url));
  assert.ok(rows.every((row) => row.source_key === `${brandId}|url:${url}`), "evidence joins the source row by the same key");
});

test("the same page in two runs keeps one evidence set per run, so history is not overwritten", async () => {
  const sql = await getSql();
  const { organizationId, brandId } = await tenant(sql);
  const url = "https://shop.example/history";
  const service = new DiscoveryService(undefined, declaringCrawler);
  const one = await service.startDiscoveryRun({ organizationId, brandId, scope: "scrape_page", seeds: [url], sql });
  const two = await service.startDiscoveryRun({ organizationId, brandId, scope: "scrape_page", seeds: [url], sql });
  assert.equal((await evidenceRows(sql, one.run.id)).length, 3);
  assert.equal((await evidenceRows(sql, two.run.id)).length, 3);
});

test("frontier-discovered pages also keep their structured data", async () => {
  const sql = await getSql();
  const { organizationId, brandId } = await tenant(sql);
  const url = "https://shop.example/frontier";
  const service = new DiscoveryService(undefined, declaringCrawler);
  const { run } = await service.startDiscoveryRun({ organizationId, brandId, scope: "page_plus_links", seeds: [url], sql });
  const rows = await evidenceRows(sql, run.id);
  assert.ok(rows.some((row) => row.kind === "json_ld" && row.page_url === url));
});

test("a failed evidence insert makes the run partial and does not drop the discovered item", async () => {
  const real = await getSql();
  const { organizationId, brandId } = await tenant(real);
  let failed = false;
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!failed && strings.join("?").includes("insert into discovered_page_evidence")) {
      failed = true;
      throw new Error("fixture: injected evidence failure");
    }
    return (real as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>)(strings, ...values);
  }) as unknown as Sql;
  const url = "https://shop.example/evidence-fails";
  const service = new DiscoveryService(undefined, declaringCrawler);
  const { run, items } = await service.startDiscoveryRun({ organizationId, brandId, scope: "scrape_page", seeds: [url], sql });
  assert.equal(run.status, "partial");
  assert.ok(Object.keys(run.perSourceErrors).some((key) => key.startsWith("persist_evidence_")));
  assert.equal(items.length, 1, "the page's discovered item is still stored");
  const stored = await real<{ count: number }>`select count(*)::int as count from discovered_items where run_id = ${run.id}`;
  assert.equal(Number(stored[0]!.count), 1);
});
