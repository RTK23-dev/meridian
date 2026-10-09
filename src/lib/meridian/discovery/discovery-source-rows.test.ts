import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { DiscoveryService, type PageCrawler } from "./service.ts";

type CrawlResult = Awaited<ReturnType<PageCrawler>>;

/** Scripted page fetch: every URL returns a page whose title names the URL. */
const crawler: PageCrawler = (async (url: string) => ({
  url,
  finalUrl: url,
  title: `Page ${url}`,
  description: `Description for ${url}`,
  canonicalUrl: url,
  openGraph: {},
  jsonLd: [],
  cards: [],
  outboundLinks: [],
}) as unknown as CrawlResult) as PageCrawler;

async function tenant(sql: Sql, members: string[]) {
  const suffix = randomUUID().slice(0, 8);
  const organizationId = `org-srcrows-${suffix}`;
  await sql`insert into organizations (id, name, slug, created_by) values (${organizationId}, ${organizationId}, ${organizationId}, 'test-user')`;
  const brands: string[] = [];
  for (const label of members) {
    const brandId = `brand-srcrows-${label}-${suffix}`;
    await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${organizationId}, ${brandId}, 'test-user')`;
    brands.push(brandId);
  }
  return { organizationId, brands };
}

async function sourceRows(sql: Sql, organizationId: string, canonicalUrl: string) {
  return sql<{ brand_id: string; canonical_url: string; metadata: unknown }>`
    select brand_id, canonical_url, metadata from sources
    where organization_id = ${organizationId} and canonical_url = ${canonicalUrl}
    order by brand_id
  `;
}

test("the same page discovered in two runs is one source row for the brand", async () => {
  const sql = await getSql();
  const { organizationId, brands } = await tenant(sql, ["a"]);
  const url = "https://shop.example/kitchen-sponge";
  const service = new DiscoveryService(undefined, crawler);
  await service.startDiscoveryRun({ organizationId, brandId: brands[0]!, scope: "scrape_page", seeds: [url], sql });
  await service.startDiscoveryRun({ organizationId, brandId: brands[0]!, scope: "scrape_page", seeds: [url], sql });
  const rows = await sourceRows(sql, organizationId, url);
  assert.equal(rows.length, 1, "a second run must update the existing source, not add one");
  assert.equal(rows[0]!.brand_id, brands[0]);
});

test("distinct products on one path are distinct source rows", async () => {
  const sql = await getSql();
  const { organizationId, brands } = await tenant(sql, ["a"]);
  const service = new DiscoveryService(undefined, crawler);
  await service.startDiscoveryRun({
    organizationId,
    brandId: brands[0]!,
    scope: "scrape_page",
    seeds: ["https://shop.example/product?id=1", "https://shop.example/product?id=2"],
    sql,
  });
  const rows = await sql<{ canonical_url: string }>`
    select canonical_url from sources where organization_id = ${organizationId} order by canonical_url
  `;
  assert.deepEqual(rows.map((row) => row.canonical_url), [
    "https://shop.example/product?id=1",
    "https://shop.example/product?id=2",
  ]);
});

test("the same web page discovered for two brands in one organization keeps a row per brand", async () => {
  const sql = await getSql();
  const { organizationId, brands } = await tenant(sql, ["a", "b"]);
  const url = "https://shop.example/shared-page";
  const service = new DiscoveryService(undefined, crawler);
  await service.startDiscoveryRun({ organizationId, brandId: brands[0]!, scope: "scrape_page", seeds: [url], sql });
  await service.startDiscoveryRun({ organizationId, brandId: brands[1]!, scope: "scrape_page", seeds: [url], sql });
  const rows = await sourceRows(sql, organizationId, url);
  assert.deepEqual(rows.map((row) => row.brand_id), [...brands].sort());
});
