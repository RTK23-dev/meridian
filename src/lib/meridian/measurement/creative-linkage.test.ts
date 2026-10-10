import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import { executeApprovedCreativePlan } from "../studio/session.server.ts";
import { insertExecutingPlan, imagePlan, stubGoogleImage, studioTenant } from "../testing/durable-image-fixtures.ts";
import { recordTelemetry } from "../learning/telemetry-engine.ts";
import { linkCreativeMeasurement } from "./creative-linkage.ts";

// The artifact store and the test image double are testing-runtime only. Production never selects either.
process.env.MERIDIAN_TESTING_RUNTIME = "true";

async function oneImageCreative(sql: Awaited<ReturnType<typeof getSql>>, label: string) {
  const tenant = await studioTenant(sql, label);
  const plan = imagePlan(tenant.decisionId, { maxSpendUsd: 0.5 });
  await insertExecutingPlan(sql, tenant, plan, tenant.userId);
  const stub = stubGoogleImage(sql, tenant.organizationId, "ready");
  try {
    await executeApprovedCreativePlan(sql, { organizationId: tenant.organizationId, role: "member" }, tenant.userId, plan);
  } finally {
    stub.restore();
  }
  const [row] = await sql<{ id: string }>`
    select id from creative_records where organization_id = ${tenant.organizationId} order by id asc limit 1
  `;
  assert.ok(row, "an image creative was materialized");
  return { tenant, creativeId: row.id };
}

test("an unpublished, unmeasured creative links to its production job and to nothing else", async () => {
  const sql = await getSql();
  const { tenant, creativeId } = await oneImageCreative(sql, "measure-none");
  const measurement = await linkCreativeMeasurement(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, creativeId });
  assert.ok(measurement);
  assert.equal(measurement.linked.productionJob, true);
  assert.equal(measurement.linked.publish, false, "no receipt means not published");
  assert.equal(measurement.linked.telemetry, false, "no telemetry means not measured");
  assert.deepEqual(measurement.publishReceipts, []);
  assert.equal(measurement.telemetry.rowCount, 0);
});

test("a publish receipt is linked by the creative id, and a test-provider receipt is flagged as not live", async () => {
  const sql = await getSql();
  const { tenant, creativeId } = await oneImageCreative(sql, "measure-receipt");
  await sql`
    insert into provider_objects (id, organization_id, brand_id, provider, object_type, idempotency_key, external_id, status)
    values (${`receipt-${creativeId}`}, ${tenant.organizationId}, ${tenant.brandId}, 'test', 'ad', ${creativeId}, 'test-ad-1', 'active')
  `;
  const measurement = await linkCreativeMeasurement(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, creativeId });
  assert.ok(measurement);
  assert.equal(measurement.linked.publish, true);
  assert.equal(measurement.publishReceipts.length, 1);
  assert.equal(measurement.publishReceipts[0]?.externalId, "test-ad-1");
  assert.equal(measurement.publishReceipts[0]?.isTestProvider, true, "a test receipt is never read as a live publish");
});

test("telemetry is linked by creative id, and each row carries its recency decay weight from the telemetry engine", async () => {
  const sql = await getSql();
  const { tenant, creativeId } = await oneImageCreative(sql, "measure-telemetry");
  await recordTelemetry(sql, {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    platform: "meta",
    creativeId,
    views: 1200,
    recordedAt: new Date().toISOString(),
  });
  const measurement = await linkCreativeMeasurement(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, creativeId });
  assert.ok(measurement);
  assert.equal(measurement.linked.telemetry, true);
  assert.equal(measurement.telemetry.rowCount, 1);
  assert.ok(measurement.telemetry.latestRecordedAt, "the latest observation time is reported");

  const [row] = await sql<{ decay_weight: number }>`
    select decay_weight from unified_performance_telemetry where creative_id = ${creativeId}
  `;
  assert.ok(row);
  assert.ok(row.decay_weight > 0.99 && row.decay_weight <= 1, "a fresh observation has almost full weight");
});

test("another tenant's receipt and telemetry for the same creative id are not linked", async () => {
  const sql = await getSql();
  const owner = await oneImageCreative(sql, "measure-owner");
  const other = await studioTenant(sql, "measure-other");
  await sql`
    insert into provider_objects (id, organization_id, brand_id, provider, object_type, idempotency_key, external_id, status)
    values (${`receipt-x-${owner.creativeId}`}, ${owner.tenant.organizationId}, ${owner.tenant.brandId}, 'test', 'ad', ${owner.creativeId}, 'owner-ad', 'active')
  `;
  const seen = await linkCreativeMeasurement(sql, { organizationId: other.organizationId, brandId: other.brandId, creativeId: owner.creativeId });
  assert.equal(seen, null, "the creative itself is not visible to another tenant");
});

test("a Meta video receipt keyed by brand and creative is linked, as the Meta publish path writes it", async () => {
  const sql = await getSql();
  const { tenant, creativeId } = await oneImageCreative(sql, "measure-meta");
  await sql`
    insert into provider_objects (id, organization_id, brand_id, provider, object_type, idempotency_key, external_id, status)
    values (${`receipt-meta-${creativeId}`}, ${tenant.organizationId}, ${tenant.brandId}, 'meta', 'video',
            ${`${tenant.brandId}:${creativeId}:video`}, 'meta-video-9', 'stored')
  `;
  const measurement = await linkCreativeMeasurement(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, creativeId });
  assert.ok(measurement);
  assert.equal(measurement.publishReceipts[0]?.externalId, "meta-video-9");
  assert.equal(measurement.publishReceipts[0]?.isTestProvider, false, "a Meta receipt is not flagged as a test");
});
