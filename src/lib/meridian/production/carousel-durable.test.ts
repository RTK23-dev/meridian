import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import { CreativeDecisionEngine } from "../creative/engine.ts";
import { executeApprovedCreativePlan } from "../studio/session.server.ts";
import { TEST_PLAN_LINEAGE, TEST_PRODUCTION_CONTEXT } from "../testing/plan-lineage.ts";
import {
  insertExecutingPlan,
  jobsOf,
  reservationsOf,
  stubGoogleImage,
  studioTenant,
} from "../testing/durable-image-fixtures.ts";
import { completeProductionJob, settleCarouselParent } from "./materialization.ts";
import { pollProductionJobs } from "./poller.ts";

// The artifact store and the test image double are testing-runtime only. Production never selects either.
process.env.MERIDIAN_TESTING_RUNTIME = "true";

const SLIDES = 4;
/** A $0.80 cap across four unpriced slides: each slide reserves an equal $0.20 share. */
const CAP_USD = 0.8;
const SHARE_MICROS = 200_000;

function carouselPlan(decisionId: string) {
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
    constraints: { maxSpendUsd: CAP_USD },
  });
}

const parentIdOf = (planId: string) => `carousel-job-${planId}`;
const carouselCreativeIdOf = (parentId: string) => `carousel-creative-${parentId}`;

type SlideRow = {
  id: string;
  status: string;
  sequence_index: number;
  materialized_at: unknown;
  materialized_creative_id: string | null;
  artifact_id: string | null;
  error_code: string | null;
};

async function slidesOf(sql: Awaited<ReturnType<typeof getSql>>, parentId: string) {
  return sql<SlideRow>`
    select id, status, sequence_index, materialized_at, materialized_creative_id, artifact_id, error_code
    from production_jobs where parent_job_id = ${parentId} order by sequence_index asc, id asc
  `;
}

async function parentOf(sql: Awaited<ReturnType<typeof getSql>>, parentId: string) {
  const rows = await sql<{ modality: string; status: string; error_code: string | null; materialized_creative_id: string | null; materialized_at: unknown; output: unknown }>`
    select modality, status, error_code, materialized_creative_id, materialized_at, output from production_jobs where id = ${parentId}
  `;
  return rows[0];
}

async function carouselCreative(sql: Awaited<ReturnType<typeof getSql>>, parentId: string) {
  const rows = await sql<{ id: string; format: string; status: string; workflow: unknown }>`
    select id, format, status, workflow from creative_records where id = ${carouselCreativeIdOf(parentId)}
  `;
  const row = rows[0];
  if (!row) return null;
  const workflow = typeof row.workflow === "string" ? (JSON.parse(row.workflow) as Record<string, unknown>) : (row.workflow as Record<string, unknown>);
  return { ...row, workflow };
}

test("a carousel is one parent job whose four slides are ordered children, each materialized, and the carousel creative references them in order", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "carousel-ok");
  const plan = carouselPlan(tenant.decisionId);
  await insertExecutingPlan(sql, tenant, plan, tenant.userId);
  const stub = stubGoogleImage(sql, tenant.organizationId, "ready");
  try {
    await executeApprovedCreativePlan(sql, { organizationId: tenant.organizationId, role: "member" }, tenant.userId, plan);
  } finally {
    stub.restore();
  }

  const parentId = parentIdOf(plan.id);
  const parent = await parentOf(sql, parentId);
  assert.equal(parent?.modality, "carousel");
  assert.equal(parent?.status, "COMPLETED");
  assert.ok(parent?.materialized_at, "the carousel is materialized");
  assert.equal(parent?.materialized_creative_id, carouselCreativeIdOf(parentId));

  const slides = await slidesOf(sql, parentId);
  assert.deepEqual(slides.map((slide) => slide.sequence_index), [0, 1, 2, 3], "slides are children in position order");
  for (const slide of slides) {
    assert.equal(slide.status, "COMPLETED");
    assert.ok(slide.materialized_at, "every slide is materialized");
    assert.ok(slide.artifact_id, "every slide has a stored artifact");
  }

  const creative = await carouselCreative(sql, parentId);
  assert.ok(creative, "a carousel creative exists");
  assert.equal(creative.format, "carousel");
  assert.equal(creative.status, "in_review", "a carousel waits for human review, as its slides do");
  const references = creative.workflow.slides as Array<{ index: number; jobId: string; creativeId: string; assetId: string }>;
  assert.deepEqual(references.map((reference) => reference.index), [0, 1, 2, 3], "the carousel lists its slides in position order");
  assert.deepEqual(references.map((reference) => reference.jobId), slides.map((slide) => slide.id));
  assert.deepEqual(references.map((reference) => reference.creativeId), slides.map((slide) => slide.materialized_creative_id));
  assert.deepEqual(references.map((reference) => reference.assetId), slides.map((slide) => `image-asset-${slide.id}`));
  assert.equal(creative.workflow.productionJobId, parentId);
});

test("each slide reserves its share once and settles once, and the carousel parent holds no reservation of its own", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "carousel-budget");
  const plan = carouselPlan(tenant.decisionId);
  await insertExecutingPlan(sql, tenant, plan, tenant.userId);
  const stub = stubGoogleImage(sql, tenant.organizationId, "ready");
  try {
    await executeApprovedCreativePlan(sql, { organizationId: tenant.organizationId, role: "member" }, tenant.userId, plan);
  } finally {
    stub.restore();
  }

  const parentId = parentIdOf(plan.id);
  const reservations = await reservationsOf(sql, tenant.organizationId);
  assert.equal(reservations.length, SLIDES, "one reservation per slide, none for the parent");
  assert.ok(reservations.every((row) => row.production_job_id !== parentId), "the parent holds no reservation");
  for (const row of reservations) {
    assert.equal(Number(row.amount_micros), SHARE_MICROS, "each slide reserves its equal share of the cap");
    assert.equal(row.status, "RECONCILED", "each slide settles");
    assert.equal(Number(row.settled_spend_micros), SHARE_MICROS, "each slide settles at its reserved ceiling");
  }
  assert.equal(reservations.reduce((sum, row) => sum + Number(row.amount_micros), 0), SLIDES * SHARE_MICROS);

  // Settling the carousel again neither reserves nor settles anything else.
  await settleCarouselParent(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, productionJobId: parentId });
  assert.equal((await reservationsOf(sql, tenant.organizationId)).length, SLIDES);
});

test("slides are ordered by their position even when they materialize in the reverse order", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "carousel-order");
  const plan = carouselPlan(tenant.decisionId);
  // No approver yet: each slide completes with its artifact stored but cannot be materialized until the plan is approved.
  await insertExecutingPlan(sql, tenant, plan, null);
  const stub = stubGoogleImage(sql, tenant.organizationId, "ready");
  try {
    await executeApprovedCreativePlan(sql, { organizationId: tenant.organizationId, role: "member" }, tenant.userId, plan).catch(() => undefined);
  } finally {
    stub.restore();
  }

  const parentId = parentIdOf(plan.id);
  const pending = await slidesOf(sql, parentId);
  assert.equal(pending.length, SLIDES);
  assert.ok(pending.every((slide) => slide.status === "COMPLETED" && slide.materialized_at == null), "slides wait for materialization");
  assert.equal((await parentOf(sql, parentId))?.status, "SUBMITTING", "the carousel waits for its slides");
  // Completed-but-unmaterialized slides are not the carousel's slides yet: settling now is pending, and makes nothing.
  assert.equal(
    await settleCarouselParent(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, productionJobId: parentId }),
    "pending",
  );
  assert.equal(await carouselCreative(sql, parentId), null, "no carousel is made from unmaterialized slides");

  try {
    await sql`update creative_plans set approved_by = ${tenant.userId} where id = ${plan.id}`;
    // Materialize the slides directly, in the order 3, 2, 1, 0, so the completion order is fixed by the test rather than
    // by which job a poller happens to claim first. Position 0 completes last.
    const ref = (productionJobId: string) => ({ organizationId: tenant.organizationId, brandId: tenant.brandId, productionJobId });
    const slideAt = (index: number) => {
      const slide = pending.find((row) => row.sequence_index === index);
      assert.ok(slide, `slide at position ${index} exists`);
      return slide;
    };
    for (const index of [3, 2, 1]) {
      await completeProductionJob(sql, ref(slideAt(index).id));
      assert.equal(await carouselCreative(sql, parentId), null, `the carousel waits while position 0 is unmaterialized (after position ${index})`);
    }
    await completeProductionJob(sql, ref(slideAt(0).id));

    const materialized = await slidesOf(sql, parentId);
    assert.ok(materialized.every((slide) => slide.materialized_at != null), "every slide is materialized");

    const creative = await carouselCreative(sql, parentId);
    assert.ok(creative, "the carousel completes once its last slide materializes");
    const order = (creative.workflow.slides as Array<{ index: number }>).map((reference) => reference.index);
    assert.deepEqual(order, [0, 1, 2, 3], "the carousel lists slides by position, not by when they materialized");
    assert.equal((await parentOf(sql, parentId))?.status, "COMPLETED");
  } finally {
    await sql`
      update production_jobs set status = 'CANCELLED', error_code = 'released by test'
      where creative_plan_id = ${plan.id} and materialized_at is null
    `;
  }
});

test("a slide that fails leaves the carousel incomplete: no carousel creative, the other slides keep theirs, and the failed slide's reservation is released", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "carousel-partial");
  const plan = carouselPlan(tenant.decisionId);
  await insertExecutingPlan(sql, tenant, plan, tenant.userId);
  const stub = stubGoogleImage(sql, tenant.organizationId, (seed) => (seed.endsWith(":carousel_slide:1") ? "not-connected" : "ready"));
  try {
    await executeApprovedCreativePlan(sql, { organizationId: tenant.organizationId, role: "member" }, tenant.userId, plan);
  } finally {
    stub.restore();
  }

  const parentId = parentIdOf(plan.id);
  const parent = await parentOf(sql, parentId);
  assert.equal(parent?.status, "FAILED");
  assert.equal(parent?.error_code, "CAROUSEL_INCOMPLETE");
  assert.equal(parent?.materialized_creative_id, null);
  assert.equal(await carouselCreative(sql, parentId), null, "an incomplete carousel is not created");

  const slides = await slidesOf(sql, parentId);
  assert.deepEqual(slides.map((slide) => slide.status), ["COMPLETED", "FAILED", "COMPLETED", "COMPLETED"]);
  assert.equal(slides[1]?.error_code, "NOT_CONNECTED");
  for (const slide of [slides[0], slides[2], slides[3]]) {
    assert.ok(slide?.materialized_creative_id, "the slides that completed keep their own creatives");
  }
  const output = (await sql<{ output: unknown }>`select output from production_jobs where id = ${parentId}`)[0]?.output as { completedSlides: number[] };
  assert.deepEqual(output.completedSlides, [0, 2, 3], "the record names the slides that did complete");

  const reservations = await reservationsOf(sql, tenant.organizationId);
  const bySlide = new Map(reservations.map((row) => [row.production_job_id, row.status]));
  assert.equal(bySlide.get(slides[1]!.id), "RELEASED", "the failed slide was never submitted, so its reservation is released");
  for (const slide of [slides[0], slides[2], slides[3]]) assert.equal(bySlide.get(slide!.id), "RECONCILED");
  assert.ok(reservations.every((row) => row.status !== "RESERVED"), "nothing is left held");
});

test("an ambiguous slide keeps the carousel pending: it is neither completed nor incomplete, and no carousel creative is made", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "carousel-ambiguous");
  const plan = carouselPlan(tenant.decisionId);
  await insertExecutingPlan(sql, tenant, plan, tenant.userId);
  const stub = stubGoogleImage(sql, tenant.organizationId, (seed) => (seed.endsWith(":carousel_slide:1") ? "failed" : "ready"));
  const parentId = parentIdOf(plan.id);
  try {
    await assert.rejects(
      executeApprovedCreativePlan(sql, { organizationId: tenant.organizationId, role: "member" }, tenant.userId, plan),
      /reservation is held for reconciliation/,
    );
    const parent = await parentOf(sql, parentId);
    assert.equal(parent?.status, "SUBMITTING", "an unresolved slide keeps the carousel pending");
    assert.equal(await carouselCreative(sql, parentId), null);

    const slides = await slidesOf(sql, parentId);
    assert.deepEqual(slides.map((slide) => slide.status), ["COMPLETED", "SUBMISSION_UNKNOWN"], "later slides were never created");
    const reservations = await reservationsOf(sql, tenant.organizationId);
    assert.equal(reservations.filter((row) => row.status === "RESERVED").length, 1, "the ambiguous slide's reservation stays held");

    // The poller claims the pending carousel but must not decide it while a slide is still unresolved.
    await pollProductionJobs(sql, { limit: 50 });
    assert.equal((await parentOf(sql, parentId))?.status, "SUBMITTING", "the poller does not settle an unresolved carousel");
    assert.equal(await carouselCreative(sql, parentId), null);
  } finally {
    stub.restore();
    await sql`update production_jobs set status = 'CANCELLED', error_code = 'released by test' where creative_plan_id = ${plan.id} and status in ('SUBMITTING', 'SUBMISSION_UNKNOWN')`;
  }
});

test("settling a completed carousel again creates no second creative and changes nothing", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "carousel-idem");
  const plan = carouselPlan(tenant.decisionId);
  await insertExecutingPlan(sql, tenant, plan, tenant.userId);
  const stub = stubGoogleImage(sql, tenant.organizationId, "ready");
  try {
    await executeApprovedCreativePlan(sql, { organizationId: tenant.organizationId, role: "member" }, tenant.userId, plan);
  } finally {
    stub.restore();
  }
  const parentId = parentIdOf(plan.id);
  const count = async () => (await sql<{ n: number }>`
    select count(*)::int as n from creative_records where organization_id = ${tenant.organizationId}
  `)[0]?.n;
  const before = await count();
  assert.equal(await settleCarouselParent(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, productionJobId: parentId }), "unchanged");
  const [slide] = await slidesOf(sql, parentId);
  assert.ok(slide);
  await completeProductionJob(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, productionJobId: slide.id });
  assert.equal(await count(), before, "no duplicate creative from a repeated completion");
  assert.equal((await parentOf(sql, parentId))?.status, "COMPLETED");
  // A job is still materialized from the same snapshot.
  const jobs = await jobsOf(sql, plan.id);
  assert.ok(jobs.every((job) => job.materialized_at != null));
});
