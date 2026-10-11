/**
 * Each planned source reports its own state: ran, not configured (with the reason), not supported, or failed (with the
 * error). The workspace is passed to every health check, and a keyed source with no saved key is listed, not dropped.
 * Keyed behaviour is driven by fake adapters registered on a fresh registry, so no provider is called.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { SourceRegistry } from "../sources/registry.ts";
import { InstagramSourceAdapter } from "../sources/adapters/instagram.ts";
import { LicensedSourceAdapter } from "../sources/adapters/licensed.ts";
import { FirstPartyAnalyticsSourceAdapter } from "../sources/adapters/first-party-analytics.ts";
import { SearchSourceAdapter } from "../sources/adapters/search.ts";
import type { SourceAdapter, SourceHealth, SourceKind, SourceReference } from "../sources/types.ts";
import { ResearchPlanner } from "./planner.ts";
import { DiscoveryService } from "./service.ts";

/** A registered adapter whose health, discovery and organization handling the test controls. */
function fakeAdapter(input: {
  id: string;
  platform: SourceKind;
  health?: (organizationId?: string) => Promise<SourceHealth>;
  discover?: SourceAdapter["discover"];
}): SourceAdapter {
  return {
    id: input.id,
    platform: input.platform,
    capabilities: {
      profileDiscovery: false, contentDiscovery: true, metadata: true, videos: false, images: false,
      comments: false, performance: false, webpages: false, search: true,
    },
    health: input.health ?? (async () => ({
      adapterId: input.id, status: "CONFIGURED", latencyMs: 0, lastCheckedAt: new Date().toISOString(),
    })),
    discover: input.discover ?? (async () => []),
    fetch: async () => {
      throw new Error("fetch is not used in discovery");
    },
  };
}

async function tenant(sql: Sql) {
  const suffix = randomUUID().slice(0, 8);
  const organizationId = `org-srcstate-${suffix}`;
  const brandId = `brand-srcstate-${suffix}`;
  await sql`insert into organizations (id, name, slug, created_by) values (${organizationId}, ${organizationId}, ${organizationId}, 'test-user')`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${organizationId}, ${brandId}, 'test-user')`;
  return { organizationId, brandId };
}

function tiktokReference(id: string): SourceReference {
  return {
    sourceId: `tt_${id}`,
    platform: "tiktok",
    canonicalUrl: `https://www.tiktok.com/@shop/video/${id}`,
    sourceAdapter: "tiktok",
    discoveredAt: new Date().toISOString(),
    metadata: { caption: `Sponge demo ${id}` },
  };
}

test("the planner passes the workspace to every health check, so a saved key is looked up in that workspace only", async () => {
  const seenOrganizations: Array<string | undefined> = [];
  const registry = new SourceRegistry();
  registry.register(fakeAdapter({
    id: "tiktok",
    platform: "tiktok",
    health: async (organizationId) => {
      seenOrganizations.push(organizationId);
      return { adapterId: "tiktok", status: "CONFIGURED", latencyMs: 0, lastCheckedAt: new Date().toISOString() };
    },
  }));

  await ResearchPlanner.planResearch(registry, { organizationId: "org-A", scope: "niche", seeds: ["sponge"] });

  assert.ok(seenOrganizations.length > 0);
  assert.ok(seenOrganizations.every((organizationId) => organizationId === "org-A"));
});

test("a keyed source with no saved key is planned as not configured, with the resolver's reason", async () => {
  const sql = await getSql();
  const { organizationId } = await tenant(sql);
  const registry = new SourceRegistry();
  const plan = await ResearchPlanner.planResearch(registry, { organizationId, scope: "url_list", seeds: ["https://shop.example"] });

  for (const adapterId of ["instagram", "twitter", "facebook", "pinterest", "linkedin", "meta_ad_library", "licensed", "search"]) {
    const step = plan.executions.find((execution) => execution.adapterId === adapterId);
    assert.ok(step, `${adapterId} is planned, not dropped`);
    assert.equal(step.status, "not_configured", `${adapterId} has no saved key`);
    assert.ok(step.reason && step.reason.length > 0, `${adapterId} carries a reason`);
  }
});

test("a source whose health reports NOT_SUPPORTED is planned as not supported, with the adapter's message", async () => {
  const registry = new SourceRegistry();
  registry.register(fakeAdapter({
    id: "search",
    platform: "search",
    health: async () => ({
      adapterId: "search", status: "NOT_SUPPORTED", latencyMs: 0,
      message: "A search key is saved, but this release does not run search queries.", lastCheckedAt: new Date().toISOString(),
    }),
  }));

  const plan = await ResearchPlanner.planResearch(registry, { organizationId: "org-x", scope: "niche", seeds: ["sponge"] });
  const search = plan.executions.find((execution) => execution.adapterId === "search");
  assert.equal(search?.status, "not_supported");
  assert.equal(search?.reason, "A search key is saved, but this release does not run search queries.");
});

test("a health check that throws is a failed source with its message, not an unavailable one with no reason", async () => {
  const registry = new SourceRegistry();
  registry.register(fakeAdapter({
    id: "youtube",
    platform: "youtube",
    health: async () => {
      throw new Error("boom");
    },
  }));

  const plan = await ResearchPlanner.planResearch(registry, { organizationId: "org-x", scope: "niche", seeds: ["sponge"] });
  const youtube = plan.executions.find((execution) => execution.adapterId === "youtube");
  assert.equal(youtube?.status, "failed");
  assert.equal(youtube?.reason, "Health check failed for youtube: boom");
});

test("items from a keyed source are stored with that adapter's provenance, and a repeat run sees them as seen before", async () => {
  const sql = await getSql();
  const { organizationId, brandId } = await tenant(sql);
  const registry = new SourceRegistry();
  const refs = [tiktokReference("1"), tiktokReference("2")];
  const seenQueries: Array<{ organizationId?: string; query?: string }> = [];
  registry.register(fakeAdapter({
    id: "tiktok",
    platform: "tiktok",
    health: async () => ({ adapterId: "tiktok", status: "CONFIGURED", latencyMs: 0, lastCheckedAt: new Date().toISOString() }),
    discover: async (query) => {
      seenQueries.push({ organizationId: query.organizationId, query: query.query });
      return refs;
    },
  }));
  const service = new DiscoveryService(registry);

  const first = await service.startDiscoveryRun({ organizationId, brandId, scope: "niche", seeds: ["sponge"], sql });
  assert.deepEqual(seenQueries[0], { organizationId, query: "sponge" }, "discovery searches in the workspace's scope");
  const tiktokState = first.run.progress.sources?.find((state) => state.adapterId === "tiktok");
  assert.ok(tiktokState && tiktokState.status === "ran" && tiktokState.itemsFound === 2);
  assert.equal(tiktokState.sourceStatus, "CONFIGURED", "the adapter's status at fetch time is recorded");

  const stored = await sql<{ adapter_id: string; source_status: string }>`
    select adapter_id, source_status from discovered_items where run_id = ${first.run.id}
  `;
  assert.equal(stored.length, 2);
  assert.ok(stored.every((row) => row.adapter_id === "tiktok" && row.source_status === "CONFIGURED"));

  const second = await service.startDiscoveryRun({ organizationId, brandId, scope: "niche", seeds: ["sponge"], sql });
  assert.equal(second.items.length, 0, "the same references are not stored a second time");
  assert.equal(second.run.progress.seenBefore, 2);
  const again = second.run.progress.sources?.find((state) => state.adapterId === "tiktok");
  assert.ok(again && again.status === "ran" && again.itemsFound === 0 && again.seenBefore === 2);
});

test("a keyed source whose discovery throws is reported as failed with the error, and nothing is shown as stored for it", async () => {
  const sql = await getSql();
  const { organizationId, brandId } = await tenant(sql);
  const registry = new SourceRegistry();
  registry.register(fakeAdapter({
    id: "tiktok",
    platform: "tiktok",
    discover: async () => {
      throw new Error("tiktok search timed out");
    },
  }));

  const { run, items } = await new DiscoveryService(registry).startDiscoveryRun({
    organizationId, brandId, scope: "niche", seeds: ["sponge"], sql,
  });

  assert.equal(items.length, 0);
  assert.equal(run.status, "failed", "no source ran successfully in this run");
  const tiktok = run.progress.sources?.find((state) => state.adapterId === "tiktok");
  assert.ok(tiktok && tiktok.status === "failed" && tiktok.reason === "tiktok search timed out");
  assert.equal(run.perSourceErrors.tiktok, "tiktok search timed out");
});

test("search, licensed and first-party sources never invent a reference, and report not configured without a workspace key", async () => {
  const search = new SearchSourceAdapter();
  const licensed = new LicensedSourceAdapter();
  const firstParty = new FirstPartyAnalyticsSourceAdapter();
  const query = { query: "sponge", niche: "sponge", advertiser: "Shop", limit: 5 };

  assert.deepEqual(await search.discover(query), [], "search returns no result without a search request");
  assert.deepEqual(await licensed.discover(query), [], "licensed returns no record without a provider request");
  assert.deepEqual(await firstParty.discover(query), [], "first-party returns no campaign without a read");

  for (const adapter of [search, licensed, firstParty]) {
    const health = await adapter.health();
    assert.equal(health.status, "NOT_CONFIGURED");
    assert.ok(health.message && health.message.length > 0, "the reason is shown");
  }
});

test("an instagram adapter with no saved key is not configured, and its discovery reads no provider", async () => {
  const instagram = new InstagramSourceAdapter();
  const health = await instagram.health();
  assert.equal(health.status, "NOT_CONFIGURED");
  assert.ok(health.message && health.message.length > 0);
  assert.deepEqual(await instagram.discover({ niche: "sponge" }), []);
});
