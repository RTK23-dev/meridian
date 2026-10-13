import assert from "node:assert/strict";
import test from "node:test";
import { DiscoveryService } from "./service.ts";
import { fixtureSourceRegistry, makeFactoryTestSql } from "../testing/factory-fixtures.ts";

test("a niche run plans only the adapters it names, and records no state for the others", async () => {
  const sql = await makeFactoryTestSql();
  await sql`insert into organizations (id, name, slug, created_by) values ('org-filter', 'Org', 'org-filter', 'user-1')`;
  await sql`insert into brands (id, organization_id, name, created_by) values ('brand-filter', 'org-filter', 'Brand', 'user-1')`;
  // No page is read in this test: the seed is a niche phrase, and the crawler is never asked for a page.
  const service = new DiscoveryService(fixtureSourceRegistry(), async () => {
    throw new Error("The crawler must not read a page in this test.");
  });

  const named = await service.startDiscoveryRun({
    organizationId: "org-filter",
    brandId: "brand-filter",
    scope: "niche",
    seeds: ["skincare"],
    adapterIds: ["youtube"],
    sql,
  });
  assert.deepEqual((named.run.progress.sources ?? []).map((state) => state.adapterId), ["youtube"]);
  assert.equal(named.run.progress.sources?.[0]?.status, "ran", "the named adapter ran");

  // Without a filter every planned adapter reports its state, so the filter is what leaves the others out.
  const everything = await service.startDiscoveryRun({
    organizationId: "org-filter",
    brandId: "brand-filter",
    scope: "niche",
    seeds: ["skincare"],
    sql,
  });
  const reported = new Set((everything.run.progress.sources ?? []).map((state) => state.adapterId));
  assert.ok(reported.has("tiktok"), "an unfiltered run reports the keyed sources");
  assert.ok(reported.has("meta_ad_library"), "an unfiltered run reports the Ad Library too");
});
