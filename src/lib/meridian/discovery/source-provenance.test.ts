import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { sourceProvenance } from "./provenance.ts";
import { sourceExternalId } from "./source-identity.ts";
import { DiscoveryService, type PageCrawler } from "./service.ts";

type CrawlResult = Awaited<ReturnType<PageCrawler>>;

const crawler: PageCrawler = (async (url: string) => ({
  url,
  finalUrl: url,
  title: `Page ${url}`,
  description: "fixture",
  canonicalUrl: url,
  openGraph: {},
  jsonLd: [],
  cards: [],
  outboundLinks: [],
}) as unknown as CrawlResult) as PageCrawler;

async function tenant(sql: Sql, brandLabels: string[]) {
  const suffix = randomUUID().slice(0, 8);
  const organizationId = `org-prov-${suffix}`;
  await sql`insert into organizations (id, name, slug, created_by) values (${organizationId}, ${organizationId}, ${organizationId}, 'test-user')`;
  const brands: string[] = [];
  for (const label of brandLabels) {
    const brandId = `brand-prov-${label}-${suffix}`;
    await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${organizationId}, ${brandId}, 'test-user')`;
    brands.push(brandId);
  }
  return { organizationId, brands };
}

test("a source lists every run and item that observed it, in discovery order", async () => {
  const sql = await getSql();
  const { organizationId, brands } = await tenant(sql, ["a"]);
  const url = "https://shop.example/provenance";
  const service = new DiscoveryService(undefined, crawler);
  const one = await service.startDiscoveryRun({ organizationId, brandId: brands[0]!, scope: "scrape_page", seeds: [url], sql });
  const two = await service.startDiscoveryRun({ organizationId, brandId: brands[0]!, scope: "scrape_page", seeds: [url], sql });

  const key = sourceExternalId({ brandId: brands[0]!, itemId: "", canonicalUrl: url });
  const provenance = await sourceProvenance(sql, { organizationId, brandId: brands[0]!, sourceKey: key });
  assert.deepEqual(provenance.runIds, [one.run.id, two.run.id].sort());
  assert.equal(provenance.observations.length, 2);
  assert.deepEqual(provenance.observations.map((o) => o.runId), [one.run.id, two.run.id]);
  assert.ok(provenance.observations.every((o) => o.sourceLocation === url));
  assert.equal(provenance.firstObservedAt, provenance.observations[0]!.discoveredAt);
  assert.equal(provenance.lastObservedAt, provenance.observations[1]!.discoveredAt);
});

test("provenance is scoped to the brand: another brand's observations of the same URL do not appear", async () => {
  const sql = await getSql();
  const { organizationId, brands } = await tenant(sql, ["a", "b"]);
  const url = "https://shop.example/shared";
  const service = new DiscoveryService(undefined, crawler);
  await service.startDiscoveryRun({ organizationId, brandId: brands[0]!, scope: "scrape_page", seeds: [url], sql });
  await service.startDiscoveryRun({ organizationId, brandId: brands[1]!, scope: "scrape_page", seeds: [url], sql });

  const key = sourceExternalId({ brandId: brands[0]!, itemId: "", canonicalUrl: url });
  const provenance = await sourceProvenance(sql, { organizationId, brandId: brands[0]!, sourceKey: key });
  assert.equal(provenance.observations.length, 1);
  assert.equal(provenance.runIds.length, 1);
});

test("provenance is scoped to the organization: another tenant cannot read a source by its key", async () => {
  const sql = await getSql();
  const mine = await tenant(sql, ["a"]);
  const theirs = await tenant(sql, ["a"]);
  const url = "https://shop.example/private";
  const service = new DiscoveryService(undefined, crawler);
  await service.startDiscoveryRun({ organizationId: theirs.organizationId, brandId: theirs.brands[0]!, scope: "scrape_page", seeds: [url], sql });

  const key = sourceExternalId({ brandId: theirs.brands[0]!, itemId: "", canonicalUrl: url });
  const provenance = await sourceProvenance(sql, { organizationId: mine.organizationId, brandId: theirs.brands[0]!, sourceKey: key });
  assert.deepEqual(provenance.observations, []);
  assert.deepEqual(provenance.runIds, []);
});
