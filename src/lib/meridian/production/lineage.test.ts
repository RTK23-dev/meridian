import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import { CreativeDecisionEngine } from "../creative/engine.ts";
import { executeApprovedCreativePlan } from "../studio/session.server.ts";
import { TEST_PLAN_LINEAGE, TEST_PRODUCTION_CONTEXT } from "../testing/plan-lineage.ts";
import { insertExecutingPlan, imagePlan, stubGoogleImage, studioTenant } from "../testing/durable-image-fixtures.ts";
import { reconstructCreativeLineage } from "./lineage.ts";

// The artifact store and the test image double are testing-runtime only. Production never selects either.
process.env.MERIDIAN_TESTING_RUNTIME = "true";

function carouselFor(decisionId: string) {
  return CreativeDecisionEngine.createPlan({
    lineage: { decisionId, evidenceRefs: TEST_PLAN_LINEAGE.evidenceRefs },
    productionContext: TEST_PRODUCTION_CONTEXT,
    scope: "carousel_only",
    autonomy: "semi_automatic",
    preferredImageProvider: "google_nano_banana",
    brief: {
      title: "Kitchen sponge",
      hook: "Tired of smelly sponges?",
      message: "Swipe to see the antibacterial mesh layer",
      cta: "Grab a 4-pack today",
      angle: "live demonstration",
      productName: "Mesh sponge",
      aspectRatio: "1:1",
      decisionId,
    },
    constraints: { maxSpendUsd: 0.8 },
  });
}

async function creativeIdOf(sql: Awaited<ReturnType<typeof getSql>>, organizationId: string, kind: string) {
  const rows = await sql<{ id: string }>`
    select id from creative_records
    where organization_id = ${organizationId} and (workflow::jsonb)->>'kind' = ${kind}
    order by id asc
  `;
  return rows.map((row) => row.id);
}

test("an image creative's lineage is complete: its job, plan, decision, and evidence, with a QC verdict that is not pending", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "lineage-image");
  const plan = imagePlan(tenant.decisionId, { maxSpendUsd: 0.5 });
  await insertExecutingPlan(sql, tenant, plan, tenant.userId);
  const stub = stubGoogleImage(sql, tenant.organizationId, "ready");
  try {
    await executeApprovedCreativePlan(sql, { organizationId: tenant.organizationId, role: "member" }, tenant.userId, plan);
  } finally {
    stub.restore();
  }
  const [creativeId] = await creativeIdOf(sql, tenant.organizationId, "image");
  assert.ok(creativeId, "an image creative was materialized");
  const lineage = await reconstructCreativeLineage(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, creativeId });
  assert.ok(lineage);
  assert.equal(lineage.modality, "image");
  assert.deepEqual(lineage.missing, [], "no link is missing");
  assert.equal(lineage.complete, true);
  assert.equal(lineage.planId, plan.id);
  assert.equal(lineage.decisionId, tenant.decisionId);
  assert.notEqual(lineage.qc, "PENDING", "a judged image has a verdict");
  assert.equal(lineage.parentJobId, null, "a single image has no carousel parent");
});

test("a carousel's lineage lists its four slides in position order, and each slide traces back to the carousel", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "lineage-carousel");
  const plan = carouselFor(tenant.decisionId);
  await insertExecutingPlan(sql, tenant, plan, tenant.userId);
  const stub = stubGoogleImage(sql, tenant.organizationId, "ready");
  try {
    await executeApprovedCreativePlan(sql, { organizationId: tenant.organizationId, role: "member" }, tenant.userId, plan);
  } finally {
    stub.restore();
  }
  const [carouselId] = await creativeIdOf(sql, tenant.organizationId, "carousel");
  assert.ok(carouselId, "a carousel creative exists");
  const lineage = await reconstructCreativeLineage(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, creativeId: carouselId });
  assert.ok(lineage);
  assert.equal(lineage.modality, "carousel");
  assert.equal(lineage.complete, true, `missing: ${lineage.missing.join(", ")}`);
  assert.deepEqual(lineage.slides.map((slide) => slide.index), [0, 1, 2, 3]);
  assert.ok(lineage.slides.every((slide) => slide.qc !== "PENDING"), "every slide has a verdict");
  assert.equal(lineage.qc, "REVIEW", "a carousel awaiting review is in review, not passed");

  const slide = lineage.slides[2];
  assert.ok(slide);
  const slideLineage = await reconstructCreativeLineage(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, creativeId: slide.creativeId });
  assert.ok(slideLineage);
  assert.equal(slideLineage.modality, "image");
  assert.equal(slideLineage.parentJobId, lineage.productionJobId, "a slide names the carousel job as its parent");
  assert.equal(slideLineage.complete, true, `missing: ${slideLineage.missing.join(", ")}`);
});

test("a creative with no recorded production job is not complete, and reports the missing link instead of guessing", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "lineage-legacy");
  const creativeId = `legacy-${tenant.organizationId}`;
  await sql`
    insert into creative_records (
      id, organization_id, brand_id, origin, title, raw_text, product_name, hook, hook_type, angle,
      message, cta, format, proof_type, opportunity_id, brief_id, status, created_by, workflow
    ) values (
      ${creativeId}, ${tenant.organizationId}, ${tenant.brandId}, 'generated', 'Legacy', '', '', '', '', '',
      '', '', 'image', '', null, ${tenant.briefId}, 'in_review', ${tenant.userId}, '{}'
    )
  `;
  const lineage = await reconstructCreativeLineage(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, creativeId });
  assert.ok(lineage);
  assert.equal(lineage.complete, false);
  assert.ok(lineage.missing.includes("production job"));
  assert.equal(lineage.modality, "unknown");
  assert.equal(lineage.qc, "REVIEW", "the status still says what a person must decide");
});

test("a lineage with its decision removed is incomplete, and names the decision", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "lineage-nodecision");
  const plan = imagePlan(tenant.decisionId, { maxSpendUsd: 0.5 });
  await insertExecutingPlan(sql, tenant, plan, tenant.userId);
  const stub = stubGoogleImage(sql, tenant.organizationId, "ready");
  try {
    await executeApprovedCreativePlan(sql, { organizationId: tenant.organizationId, role: "member" }, tenant.userId, plan);
  } finally {
    stub.restore();
  }
  await sql`update creative_plans set decision_id = null where id = ${plan.id}`;
  const [creativeId] = await creativeIdOf(sql, tenant.organizationId, "image");
  assert.ok(creativeId);
  const lineage = await reconstructCreativeLineage(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, creativeId });
  assert.ok(lineage);
  assert.equal(lineage.complete, false);
  assert.ok(lineage.missing.includes("decision"));
  assert.equal(lineage.decisionId, null, "no decision is reported when none is recorded");
});

test("another tenant's creative is not visible: lineage is null across tenants", async () => {
  const sql = await getSql();
  const owner = await studioTenant(sql, "lineage-owner");
  const other = await studioTenant(sql, "lineage-other");
  const plan = imagePlan(owner.decisionId, { maxSpendUsd: 0.5 });
  await insertExecutingPlan(sql, owner, plan, owner.userId);
  const stub = stubGoogleImage(sql, owner.organizationId, "ready");
  try {
    await executeApprovedCreativePlan(sql, { organizationId: owner.organizationId, role: "member" }, owner.userId, plan);
  } finally {
    stub.restore();
  }
  const [creativeId] = await creativeIdOf(sql, owner.organizationId, "image");
  assert.ok(creativeId);
  assert.equal(await reconstructCreativeLineage(sql, { organizationId: other.organizationId, brandId: other.brandId, creativeId }), null);
  assert.equal(await reconstructCreativeLineage(sql, { organizationId: owner.organizationId, brandId: owner.brandId, creativeId: "no-such-creative" }), null);
});
