import assert from "node:assert/strict";
import test from "node:test";
import { ResearchPlanner } from "./planner.ts";
import { SourceRegistry } from "../sources/registry.ts";
import { DiscoveryService } from "./service.ts";
import type { Sql } from "../learning/store.ts";

test("ResearchPlanner: plans appropriate adapters for scrape_page and domain", async () => {
  const registry = new SourceRegistry();
  const pagePlan = await ResearchPlanner.planResearch(registry, {
    scope: "scrape_page",
    seeds: ["https://example.com/product"],
  });

  assert.equal(pagePlan.scope, "scrape_page");
  assert.equal(pagePlan.executions.length, 1);
  assert.equal(pagePlan.executions[0].sourceKind, "website");
  assert.equal(pagePlan.executions[0].status, "eligible");
});

test("ResearchPlanner: niche research includes multi-source adapters with Cyclone as optional", async () => {
  const registry = new SourceRegistry();
  // Ensure Cyclone env vars are unset to test graceful unconfigured state
  delete process.env.CYCLONE_GATEWAY_URL;
  delete process.env.CYCLONE_DEVICE_ID;

  const nichePlan = await ResearchPlanner.planResearch(registry, {
    scope: "niche",
    seeds: ["sustainable coffee"],
  });

  assert.equal(nichePlan.scope, "niche");
  const websiteStep = nichePlan.executions.find((e) => e.adapterId === "website");
  assert.ok(websiteStep);
  assert.equal(websiteStep.status, "eligible");

  const cycloneStep = nichePlan.executions.find((e) => e.adapterId === "cyclone_scout");
  assert.ok(cycloneStep);
  assert.equal(cycloneStep.isOptional, true);
  // Unconfigured Cyclone is cleanly marked without failing
  assert.equal(cycloneStep.status, "not_configured");
  assert.equal(nichePlan.cycloneIncluded, false);
});

test("DiscoveryService: executes multi-source niche discovery when Cyclone is unconfigured", async () => {
  delete process.env.CYCLONE_GATEWAY_URL;
  delete process.env.CYCLONE_DEVICE_ID;

  const registry = new SourceRegistry();
  const service = new DiscoveryService(registry);

  const insertedSources: any[] = [];
  const mockSql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (strings.join("?").includes("insert into sources")) {
      insertedSources.push(values);
    }
    return [];
  }) as unknown as Sql;

  const result = await service.startDiscoveryRun({
    organizationId: "org-test-disc",
    brandId: "brand-test-disc",
    scope: "niche",
    seeds: ["artisan sourdough"],
    sql: mockSql,
  });

  // Discovery completes successfully even with Cyclone absent
  assert.equal(result.run.status, "completed");
  assert.ok(Array.isArray(result.items));
  // Cyclone error is noted in perSourceErrors without crashing mission
  assert.ok(result.run.perSourceErrors["cyclone_scout"]?.includes("not connected or configured"));
});
