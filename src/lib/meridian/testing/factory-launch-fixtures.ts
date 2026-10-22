// Shared launch fixtures for the Factory's publish and loop tests: one run that makes an image creative, the produce and review stages
// answered the way a person would, and the receipts the launch leaves behind. Test code only. Nothing here calls a provider.
import assert from "node:assert/strict";
import type { Sql } from "../learning/store.ts";
import { executeFactoryJob } from "../factory/worker.ts";
import type { AutomationMode, Intent } from "../factory/run-settings.ts";
import { approveStage, factoryRunFor, planRowsFor, stageJob, stubImageProvider, type FactoryTenant } from "./produce-fixtures.ts";

// The testing runtime enables the fixture paid publisher and the image double. Production never selects either.
process.env.MERIDIAN_TESTING_RUNTIME = "true";

export const CAPPED = { totalCents: 500, dailyCents: 300 };

export async function stage(sql: Sql, tenant: FactoryTenant, runId: string, jobType: string): Promise<string> {
  return executeFactoryJob(sql, stageJob(tenant, runId, jobType), { runId });
}

/** A run that makes one image creative, with the settings given. */
export async function runFor(sql: Sql, tenant: FactoryTenant, automation: AutomationMode, intent: Intent, platforms: string[]) {
  const runId = await factoryRunFor(sql, tenant, {
    automation,
    intent,
    platforms,
    formats: ["image"],
    providers: { image: "google_nano_banana" },
    caps: CAPPED,
  });
  await planRowsFor(sql, tenant, runId, ["image"]);
  return runId;
}

/**
 * Runs produce, gate and review for the run, answering each wait the way a person would in its mode. Returns the creative the run
 * made. The image provider is the stub the produce suite uses, so no provider is called.
 */
export async function producedCreative(sql: Sql, tenant: FactoryTenant, runId: string, automation: AutomationMode): Promise<string> {
  const stub = stubImageProvider();
  try {
    if (automation !== "full") {
      assert.equal(await stage(sql, tenant, runId, "factory.produce"), "awaiting-approval:factory.produce");
      await approveStage(sql, tenant, runId, "factory.produce");
    }
    assert.equal(await stage(sql, tenant, runId, "factory.produce"), "variants:1;creatives:1");
  } finally {
    stub.restore();
  }
  assert.match(await stage(sql, tenant, runId, "factory.gate"), /^gated:/);
  if (automation === "manual") {
    assert.equal(await stage(sql, tenant, runId, "factory.review"), "awaiting-approval:factory.review");
    await approveStage(sql, tenant, runId, "factory.review");
  }
  assert.match(await stage(sql, tenant, runId, "factory.review"), /^review:/);
  const [row] = await sql<{ creative_id: string }>`
    select creative_id from factory_creatives where run_id = ${runId} and organization_id = ${tenant.organizationId}
  `;
  assert.ok(row, "the run made a creative");
  return row.creative_id;
}

/**
 * A person's approval of a creative, as the review decision records it: the review and the creative move to approved.
 *
 * The rule gates in this build return block for every Factory variant, because the rights flags are not recorded yet, so no
 * variant passes on its own. The fixture moves the variant to review, which is where a person's approval is the route to publish.
 * It is the review outcome, not a gate pass. The blocked test sets block itself.
 */
export async function approveCreative(sql: Sql, creativeId: string): Promise<void> {
  await sql`update reviews set status = 'approved' where creative_id = ${creativeId}`;
  await sql`update creative_records set status = 'approved', updated_at = now() where id = ${creativeId}`;
  await sql`
    update factory_variants set gate_result = 'review'
    where id in (select variant_id from factory_creatives where creative_id = ${creativeId})
  `;
}

export async function organicRowsFor(sql: Sql, tenant: FactoryTenant, creativeId: string) {
  return sql<{ platform: string; status: string; surface: string; error: string | null }>`
    select platform, status, surface, error from organic_posts
    where organization_id = ${tenant.organizationId} and brand_id = ${tenant.brandId} and creative_id = ${creativeId}
  `;
}

export async function paidRowsFor(sql: Sql, tenant: FactoryTenant, creativeId: string) {
  return sql<{ provider: string; object_type: string; status: string; surface: string; external_id: string }>`
    select provider, object_type, status, surface, external_id from provider_objects
    where organization_id = ${tenant.organizationId} and brand_id = ${tenant.brandId} and idempotency_key = ${creativeId}
    order by object_type asc
  `;
}

