import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import { executeApprovedCreativePlan } from "../studio/session.server.ts";
import { insertExecutingPlan, imagePlan, stubGoogleImage, studioTenant } from "../testing/durable-image-fixtures.ts";
import { ingestMetaOutcomes, type MetaInsightInput } from "./outcome-ingestion.ts";

// The artifact store and the test image double are testing-runtime only. Production never selects either.
process.env.MERIDIAN_TESTING_RUNTIME = "true";

async function creativeWithMetaReceipt(sql: Awaited<ReturnType<typeof getSql>>, label: string, externalId: string) {
  const tenant = await studioTenant(sql, label);
  const plan = imagePlan(tenant.decisionId, { maxSpendUsd: 0.5 });
  await insertExecutingPlan(sql, tenant, plan, tenant.userId);
  const stub = stubGoogleImage(sql, tenant.organizationId, "ready");
  try {
    await executeApprovedCreativePlan(sql, { organizationId: tenant.organizationId, role: "member" }, tenant.userId, plan);
  } finally {
    stub.restore();
  }
  const [creative] = await sql<{ id: string }>`select id from creative_records where organization_id = ${tenant.organizationId} order by id asc limit 1`;
  assert.ok(creative);
  await sql`
    insert into provider_objects (id, organization_id, brand_id, provider, object_type, idempotency_key, external_id, status)
    values (${`r-${externalId}-${tenant.organizationId}`}, ${tenant.organizationId}, ${tenant.brandId}, 'meta', 'video',
            ${`${tenant.brandId}:${creative.id}:video`}, ${externalId}, 'stored')
  `;
  return { tenant, creativeId: creative.id };
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function insight(externalId: string, dateStart: string, impressions: number): MetaInsightInput {
  return {
    externalId,
    currency: "USD",
    timezone: "UTC",
    row: { impressions: String(impressions), clicks: "12", spend: "3.50", actions: [], date_start: dateStart },
  };
}

test("an insight row is attributed through its receipt, normalized, stored once, and decayed by its age", async () => {
  const sql = await getSql();
  const externalId = `ad-${Date.now()}`;
  const { tenant, creativeId } = await creativeWithMetaReceipt(sql, "outcome-ok", externalId);

  const first = await ingestMetaOutcomes(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId }, [
    insight(externalId, daysAgo(60), 1200),
  ]);
  assert.equal(first.ingested, 1);
  const [row] = await sql<{ creative_id: string; impressions: number; spend_cents: number; decay_weight: number }>`
    select creative_id, impressions, spend_cents, decay_weight from unified_performance_telemetry
    where organization_id = ${tenant.organizationId} and external_post_id = ${externalId}
  `;
  assert.ok(row);
  assert.equal(row.creative_id, creativeId, "the row is attributed to the creative its receipt names");
  assert.equal(Number(row.impressions), 1200, "the normalizer's impressions are stored");
  assert.equal(Number(row.spend_cents), 350, "spend is stored in cents, from the normalizer");
  // A 60-day-old observation with a 14-day half-life keeps about 4% of its weight.
  assert.ok(Number(row.decay_weight) < 0.1, `an old observation is decayed, got ${row.decay_weight}`);

  const again = await ingestMetaOutcomes(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId }, [
    insight(externalId, daysAgo(60), 1200),
  ]);
  assert.equal(again.duplicate, 1, "the same ad and day is not stored twice");
  assert.equal(again.ingested, 0);
  const count = await sql<{ n: number }>`select count(*)::int as n from unified_performance_telemetry where organization_id = ${tenant.organizationId} and external_post_id = ${externalId}`;
  assert.equal(count[0]?.n, 1);
});

test("a row for an ad with no receipt, and a row with no date, are counted and not stored", async () => {
  const sql = await getSql();
  const externalId = `ad-${Date.now()}-b`;
  const { tenant } = await creativeWithMetaReceipt(sql, "outcome-skip", externalId);
  const result = await ingestMetaOutcomes(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId }, [
    insight("ad-with-no-receipt", daysAgo(1), 50),
    insight(externalId, "", 50),
  ]);
  assert.equal(result.unattributed, 1, "an ad with no receipt is not attributed to any creative");
  assert.equal(result.undated, 1, "a row with no date is not stored, because its recency is unknown");
  assert.equal(result.ingested, 0);
  const stored = await sql<{ n: number }>`select count(*)::int as n from unified_performance_telemetry where organization_id = ${tenant.organizationId}`;
  assert.equal(stored[0]?.n, 0);
});

test("an ad whose receipts name two creatives is ambiguous: nothing is guessed and nothing is stored", async () => {
  const sql = await getSql();
  const externalId = `ad-${Date.now()}-c`;
  const { tenant, creativeId } = await creativeWithMetaReceipt(sql, "outcome-ambiguous", externalId);
  const otherCreativeId = `other-${creativeId}`;
  await sql`
    insert into creative_records (
      id, organization_id, brand_id, origin, title, raw_text, product_name, hook, hook_type, angle,
      message, cta, format, proof_type, opportunity_id, brief_id, status, created_by, workflow
    ) values (
      ${otherCreativeId}, ${tenant.organizationId}, ${tenant.brandId}, 'generated', 'Other', '', '', '', '', '',
      '', '', 'image', '', null, ${tenant.briefId}, 'in_review', ${tenant.userId}, '{}'
    )
  `;
  await sql`
    insert into provider_objects (id, organization_id, brand_id, provider, object_type, idempotency_key, external_id, status)
    values (${`r2-${otherCreativeId}`}, ${tenant.organizationId}, ${tenant.brandId}, 'meta', 'video',
            ${`${tenant.brandId}:${otherCreativeId}:video`}, ${externalId}, 'stored')
  `;
  const result = await ingestMetaOutcomes(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId }, [insight(externalId, daysAgo(1), 80)]);
  assert.equal(result.ambiguous, 1);
  assert.equal(result.ingested, 0);
});

test("another tenant's receipt for the same ad is not used to attribute a row", async () => {
  const sql = await getSql();
  const externalId = `ad-${Date.now()}-d`;
  const { creativeId: ownerCreative } = await creativeWithMetaReceipt(sql, "outcome-owner", externalId);
  const other = await studioTenant(sql, "outcome-other");
  const result = await ingestMetaOutcomes(sql, { organizationId: other.organizationId, brandId: other.brandId }, [insight(externalId, daysAgo(1), 80)]);
  assert.equal(result.unattributed, 1, "the owner's receipt does not attribute the other tenant's row");
  assert.ok(ownerCreative);
});
