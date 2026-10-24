import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import { createTenantFixture, execute, injectProvider, job } from "../testing/production-fixtures.ts";
import { ProductionRouter } from "./router.ts";
import type { CreativeSpec, ProductionProvider } from "./types.ts";

function fakeProvider(id: string, costPerSecondEstimateUsd: number, zeroSpend = false): ProductionProvider {
  return {
    id,
    capabilities: { zeroSpend, averageLatencySeconds: 1, costPerSecondEstimateUsd },
    health: async () => ({ id, state: "CONFIGURED", capabilities: [], detail: "", checkedAt: new Date().toISOString() }),
  } as unknown as ProductionProvider;
}

function spec(overrides: Partial<CreativeSpec> = {}): CreativeSpec {
  return {
    id: "spec-1", organizationId: "org", brandId: "brand", title: "t", modality: "video", format: "ugc",
    aspectRatio: "9:16", durationTargetSeconds: 8, hookLine: "h", script: "s", scenes: [],
    ...overrides,
  } as CreativeSpec;
}

function router(providers: ProductionProvider[]) {
  return new ProductionRouter({ runtime: "production", providers });
}

const FULL = () => [
  fakeProvider("google_omni", 0.15),
  fakeProvider("hypit", 0.05),
  fakeProvider("higgsfield", 0.15),
  fakeProvider("manual_cloud", 0, true),
];

test("the router records its selection: google_omni for an 8 second 9:16 video under BALANCED, with the model and the estimate", async () => {
  const { provider, selection } = await router(FULL()).selectForSpec(spec(), "BALANCED");
  assert.equal(provider.id, "google_omni");
  assert.equal(selection.chosen?.modelId, "gemini-omni-1.1-flash");
  assert.equal(selection.chosen?.estimateUsd, 1.2);
});

test("the router never sends a 4:5 video to a provider that does not offer 4:5, and says which provider it chose instead", async () => {
  const { provider, selection } = await router(FULL()).selectForSpec(spec({ aspectRatio: "4:5" }), "BALANCED");
  assert.equal(provider.id, "hypit");
  assert.ok(selection.rejected.some((item) => item.providerId === "google_omni" && item.reasons.some((r) => r.includes("4:5"))));
});

test("an explicitly requested provider that cannot satisfy the spec is refused, not silently used", async () => {
  await assert.rejects(router(FULL()).selectForSpec(spec({ aspectRatio: "4:5" }), "BALANCED", "google_omni"), /4:5/);
});

test("automatic routing never falls back to the zero-spend manual workflow", async () => {
  await assert.rejects(router([fakeProvider("manual_cloud", 0, true)]).selectForSpec(spec(), "BALANCED"), /No eligible production provider/);
});

test("a job records the provider choice and its estimate on the durable job, through the real execution path", async () => {
  const sql = await getSql();
  const tenant = await createTenantFixture(sql, "selection", null, "google_omni", "gemini-omni-1.1-flash");
  const injected = injectProvider("google_omni", async (spec) => job(spec, "QUEUED"));
  try {
    await execute(sql, tenant, tenant.plan);
    const [row] = await sql<{ input: unknown }>`select input from production_jobs where creative_plan_id = ${tenant.plan.id}`;
    const input = typeof row!.input === "string" ? JSON.parse(row!.input) : row!.input;
    assert.equal(input.providerSelection.chosen.providerId, "google_omni");
    assert.equal(input.providerSelection.chosen.modelId, "gemini-omni-1.1-flash");
    assert.equal(typeof input.providerSelection.chosen.estimateUsd, "number");
    assert.ok(Array.isArray(input.providerSelection.rejected));
  } finally {
    await sql`update production_jobs set status = 'CANCELLED', error_message = 'released by test' where creative_plan_id = ${tenant.plan.id}`;
    injected.restore();
  }
});
