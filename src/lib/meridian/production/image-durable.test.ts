import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import { CreativeDecisionEngine } from "../creative/engine.ts";
import type { Sql } from "../learning/store.ts";
import { executeApprovedCreativePlan } from "../studio/session.server.ts";
import { TEST_PLAN_LINEAGE, TEST_PRODUCTION_CONTEXT } from "../testing/plan-lineage.ts";
import { materializeImageArtifact, materializeVideoArtifact, completeProductionJob } from "./materialization.ts";
import { pollProductionJobs } from "./poller.ts";
import { productionRouter } from "./router.ts";
import type { ImageGenerationInput, ImageGenerationOutcome, ProductionImageProvider } from "./image-providers.ts";

// The artifact store and the test image double are testing-runtime only. Production never selects either.
process.env.MERIDIAN_TESTING_RUNTIME = "true";

// A 1x1 PNG. The durable artifact path verifies it by its magic bytes, as it would any provider image.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG = new Uint8Array(Buffer.from(PNG_BASE64, "base64"));

type Behaviour = "ready" | "failed" | "not-connected";

async function studioTenant(sql: Sql, label: string) {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userId = `user-dur-${suffix}`;
  const organizationId = `org-dur-${suffix}`;
  const brandId = `brand-dur-${suffix}`;
  const briefId = `brief-dur-${suffix}`;
  const decisionId = `jev-dur-${suffix}`;
  await sql`insert into "user" (id, name, email, "emailVerified") values (${userId}, 'Fixture User', ${`${userId}@fixture.example`}, true)`;
  await sql`insert into organizations (id, name, slug, created_by) values (${organizationId}, ${organizationId}, ${organizationId}, ${userId})`;
  await sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${suffix}`}, ${organizationId}, ${userId}, 'member')`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${organizationId}, ${brandId}, ${userId})`;
  await sql`
    insert into jev_decisions (
      id, organization_id, brand_id, correlation_id, question_id, question_version, subject_type, subject_id,
      input, evidence, probability, confidence, thresholds, decision, reasons
    ) values (
      ${decisionId}, ${organizationId}, ${brandId}, ${briefId}, 'opportunity_gate.v2', '2', 'brief', ${briefId},
      '{}', '[]', 0.95, 0.9, '{}', 'AUTO_APPROVE', '[]'
    )
  `;
  await sql`
    insert into briefs (
      id, organization_id, brand_id, title, angle, hook, format, context_pack, workflow, why, status, decision_id, created_by
    ) values (
      ${briefId}, ${organizationId}, ${brandId}, 'Kitchen sponge', 'live demonstration', 'Tired of smelly sponges?',
      'image', '{}', '{}', 'fixture', 'ready', ${decisionId}, ${userId}
    )
  `;
  return { userId, organizationId, brandId, briefId, decisionId };
}

/**
 * Replaces the Google image provider for one test. It stands in for the external call only: everything around the call is
 * the real lifecycle. Each call records what the database held at that moment, which is what "before the provider is
 * called" means in the tests below.
 */
function stubGoogleImage(sql: Sql, orgId: string, behaviour: Behaviour) {
  const calls: Array<{ jobStatuses: string[]; reservationStatuses: string[]; input: ImageGenerationInput }> = [];
  const stub: ProductionImageProvider = {
    id: "google_nano_banana",
    capabilities: { zeroSpend: false },
    async health() {
      return { id: "google_nano_banana", state: "CONFIGURED", capabilities: ["text-to-image"], detail: "stub", checkedAt: new Date().toISOString() };
    },
    async generate(input: ImageGenerationInput): Promise<ImageGenerationOutcome> {
      const jobs = await sql<{ status: string }>`
        select status from production_jobs where organization_id = ${orgId} and modality = 'image'
      `;
      const reservations = await sql<{ status: string }>`
        select status from budget_reservations where organization_id = ${orgId}
      `;
      calls.push({ jobStatuses: jobs.map((row) => row.status), reservationStatuses: reservations.map((row) => row.status), input });
      if (behaviour === "failed") return { status: "failed", provider: "google:nano-banana", error: "scripted provider failure" };
      if (behaviour === "not-connected") {
        return { status: "NOT_CONNECTED", provider: "google:nano-banana", error: "Google image credentials are not configured (stub)." };
      }
      return {
        status: "ready",
        provider: "google:nano-banana",
        model: input.model,
        promptVersion: input.promptVersion,
        mediaType: "image/png",
        bytes: PNG,
        width: 1,
        height: 1,
      };
    },
  };
  const original = productionRouter.getImage("google_nano_banana");
  productionRouter.registerImage(stub);
  return {
    calls,
    restore() {
      if (original) productionRouter.registerImage(original);
    },
  };
}

function imagePlan(decisionId: string, options: { maxSpendUsd?: number } = {}) {
  return CreativeDecisionEngine.createPlan({
    lineage: { decisionId, evidenceRefs: TEST_PLAN_LINEAGE.evidenceRefs },
    productionContext: TEST_PRODUCTION_CONTEXT,
    scope: "image_only",
    autonomy: "semi_automatic",
    preferredImageProvider: "google_nano_banana",
    brief: {
      title: "Kitchen sponge",
      hook: "Tired of smelly sponges?",
      message: "Swipe to see the antibacterial mesh layer",
      cta: "Grab a 4-pack today",
      angle: "live demonstration",
      productName: "Mesh sponge",
      aspectRatio: "9:16",
      decisionId,
    },
    constraints: options.maxSpendUsd === undefined ? {} : { maxSpendUsd: options.maxSpendUsd },
  });
}

async function insertExecutingPlan(sql: Sql, tenant: Awaited<ReturnType<typeof studioTenant>>, plan: ReturnType<typeof imagePlan>, approvedBy: string | null) {
  await sql`
    insert into creative_plans (
      id, organization_id, brand_id, brief_id, version, status, scope, autonomy, objective, plan_payload, budget_reserved_usd, spend_cap_usd, decision_id, approved_by
    ) values (
      ${plan.id}, ${tenant.organizationId}, ${tenant.brandId}, ${tenant.briefId}, ${plan.version}, 'executing', ${plan.scope},
      ${plan.autonomy}, ${plan.objective}, ${JSON.stringify(plan)}, 0, null, ${plan.lineage.decisionId}, ${approvedBy}
    )
  `;
}

async function jobsOf(sql: Sql, planId: string) {
  return sql<{ id: string; status: string; error_code: string | null; artifact_id: string | null; materialized_at: unknown; cost_status: string | null; estimated_cost_cents: number | null; modality: string }>`
    select id, status, error_code, artifact_id, materialized_at, cost_status, estimated_cost_cents, modality
    from production_jobs where creative_plan_id = ${planId} order by created_at asc, id asc
  `;
}

async function reservationsOf(sql: Sql, orgId: string) {
  return sql<{ id: string; production_job_id: string | null; amount_micros: string | number | bigint; status: string; settled_spend_micros: string | number | bigint | null; cost_basis: string | null; estimator_version: string | null }>`
    select id, production_job_id, amount_micros, status, settled_spend_micros, cost_basis, estimator_version from budget_reservations
    where organization_id = ${orgId} order by created_at asc, id asc
  `;
}

test("an image is a durable job: its row and reservation exist before the provider is called, and it completes with a verified artifact a creative references", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "durable-ok");
  const plan = imagePlan(tenant.decisionId, { maxSpendUsd: 0.5 });
  await insertExecutingPlan(sql, tenant, plan, tenant.userId);
  const stub = stubGoogleImage(sql, tenant.organizationId, "ready");
  try {
    await executeApprovedCreativePlan(sql, { organizationId: tenant.organizationId, role: "member" }, tenant.userId, plan);
  } finally {
    stub.restore();
  }

  assert.equal(stub.calls.length, plan.deliverables.length, "one provider call per image deliverable");
  for (const call of stub.calls) {
    assert.ok(call.jobStatuses.includes("SUBMITTING"), "the job row exists, in SUBMITTING, when the provider is called");
    assert.ok(call.reservationStatuses.includes("RESERVED"), "the budget is reserved before the provider is called");
  }

  const jobs = await jobsOf(sql, plan.id);
  assert.equal(jobs.length, plan.deliverables.length);
  for (const job of jobs) {
    assert.equal(job.modality, "image");
    assert.equal(job.status, "COMPLETED");
    assert.ok(job.artifact_id, "the job points at its stored artifact");
    assert.ok(job.materialized_at, "the job is materialized");
  }

  const artifacts = await sql<{ name: string; mime_type: string; sha256: string }>`
    select name, mime_type, sha256 from storage_objects where organization_id = ${tenant.organizationId}
  `;
  assert.equal(artifacts.length, plan.deliverables.length, "each image is stored once, as a verified artifact");
  assert.ok(artifacts.every((row) => row.mime_type === "image/png" && /^[0-9a-f]{64}$/.test(row.sha256)));

  const assets = await sql<{ storage_key: string; kind: string }>`
    select storage_key, kind from assets where organization_id = ${tenant.organizationId}
  `;
  assert.equal(assets.length, plan.deliverables.length);
  assert.ok(assets.every((asset) => asset.kind === "image" && artifacts.some((row) => row.name === asset.storage_key)),
    "every asset references a stored artifact by its storage key");

  const creatives = await sql<{ id: string; title: string; workflow: string }>`
    select id, title, workflow from creative_records where organization_id = ${tenant.organizationId}
  `;
  assert.equal(creatives.length, plan.deliverables.length, "each materialized image has a creative");
  // Variants of one run are judged against the brand as it was when the run began, so a sibling variant from this run
  // is never a duplicate of it. A later judgment that compares against this run's own output would reject siblings.
  const statuses = await sql<{ status: string }>`
    select status from creative_records where organization_id = ${tenant.organizationId}
  `;
  assert.ok(statuses.every((row) => row.status !== "rejected"), "no sibling variant is rejected as a duplicate of another from its own run");
  for (const creative of creatives) {
    assert.ok(creative.title.startsWith(TEST_PRODUCTION_CONTEXT.title), "the title comes from the plan's production context");
    assert.match(creative.title, /image \d+$/);
    assert.match(creative.workflow, /productionJobId/, "the creative records the job that produced it");
  }
});

test("an unpriced image with no plan spend cap is refused before any job row, reservation, or provider call", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "durable-nocap");
  const plan = imagePlan(tenant.decisionId);
  await insertExecutingPlan(sql, tenant, plan, tenant.userId);
  const stub = stubGoogleImage(sql, tenant.organizationId, "ready");
  try {
    await assert.rejects(
      executeApprovedCreativePlan(sql, { organizationId: tenant.organizationId, role: "member" }, tenant.userId, plan),
      /need an explicit plan spend cap/,
    );
  } finally {
    stub.restore();
  }
  assert.equal(stub.calls.length, 0, "no provider call");
  assert.equal((await jobsOf(sql, plan.id)).length, 0, "no job row");
  assert.equal((await reservationsOf(sql, tenant.organizationId)).length, 0, "no reservation");
});

test("an unpriced image reserves the plan cap's share, settles at that ceiling, and records that the cost was unknown", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "durable-ceiling");
  const plan = imagePlan(tenant.decisionId, { maxSpendUsd: 0.5 });
  await insertExecutingPlan(sql, tenant, plan, tenant.userId);
  const stub = stubGoogleImage(sql, tenant.organizationId, "ready");
  try {
    await executeApprovedCreativePlan(sql, { organizationId: tenant.organizationId, role: "member" }, tenant.userId, plan);
  } finally {
    stub.restore();
  }

  const share = Math.floor(500_000 / plan.deliverables.length);
  const reservations = await reservationsOf(sql, tenant.organizationId);
  assert.equal(reservations.length, plan.deliverables.length);
  for (const reservation of reservations) {
    assert.equal(Number(reservation.amount_micros), share, "each unpriced image reserves an equal share of the cap");
    assert.equal(reservation.status, "RECONCILED");
    assert.equal(Number(reservation.settled_spend_micros), share, "settled at the ceiling, because the provider charge is not known");
    assert.equal(reservation.cost_basis, "ESTIMATED");
    assert.equal(reservation.estimator_version, "unpriced-ceiling-v1", "the ledger says the ceiling was used, not a price");
  }

  const jobs = await jobsOf(sql, plan.id);
  for (const job of jobs) {
    assert.equal(job.cost_status, "unknown", "the cost is recorded as unknown");
    assert.equal(job.estimated_cost_cents, null, "no estimate is invented for an unknown cost");
  }
});

test("a provider failure leaves the reservation held and the job ambiguous, and nothing is materialized", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "durable-failed");
  const plan = imagePlan(tenant.decisionId, { maxSpendUsd: 0.5 });
  await insertExecutingPlan(sql, tenant, plan, tenant.userId);
  const stub = stubGoogleImage(sql, tenant.organizationId, "failed");
  try {
    await assert.rejects(
      executeApprovedCreativePlan(sql, { organizationId: tenant.organizationId, role: "member" }, tenant.userId, plan),
      /reservation is held for reconciliation/,
    );
  } finally {
    stub.restore();
  }
  const jobs = await jobsOf(sql, plan.id);
  assert.equal(jobs[0]?.status, "SUBMISSION_UNKNOWN", "a failed call may have reached the provider, so the job is not released");
  const reservations = await reservationsOf(sql, tenant.organizationId);
  assert.equal(reservations[0]?.status, "RESERVED", "the reservation stays held, never silently released");
  assert.equal((await sql<{ count: number }>`select count(*)::int as count from creative_records where organization_id = ${tenant.organizationId}`)[0]?.count, 0);
});

test("a provider with no credentials is never submitted to, and its reservation is released", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "durable-noconn");
  const plan = imagePlan(tenant.decisionId, { maxSpendUsd: 0.5 });
  await insertExecutingPlan(sql, tenant, plan, tenant.userId);
  const stub = stubGoogleImage(sql, tenant.organizationId, "not-connected");
  try {
    await executeApprovedCreativePlan(sql, { organizationId: tenant.organizationId, role: "member" }, tenant.userId, plan);
  } finally {
    stub.restore();
  }
  const jobs = await jobsOf(sql, plan.id);
  assert.ok(jobs.every((job) => job.status === "FAILED" && job.error_code === "NOT_CONNECTED"));
  const reservations = await reservationsOf(sql, tenant.organizationId);
  assert.ok(reservations.every((reservation) => reservation.status === "RELEASED"), "nothing was submitted, so nothing is held");
});

test("the video materializer refuses an image job, so an image can never be made into a video creative", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "durable-guard");
  const plan = imagePlan(tenant.decisionId, { maxSpendUsd: 0.5 });
  await insertExecutingPlan(sql, tenant, plan, tenant.userId);
  const stub = stubGoogleImage(sql, tenant.organizationId, "ready");
  try {
    await executeApprovedCreativePlan(sql, { organizationId: tenant.organizationId, role: "member" }, tenant.userId, plan);
  } finally {
    stub.restore();
  }
  const [job] = await jobsOf(sql, plan.id);
  assert.ok(job);
  await assert.rejects(
    materializeVideoArtifact(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, productionJobId: job.id }),
    /is a image job; the video materializer refuses it/,
  );
});

test("materialization is idempotent: completing a materialized image again creates no second creative or judgment", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "durable-idem");
  const plan = imagePlan(tenant.decisionId, { maxSpendUsd: 0.5 });
  await insertExecutingPlan(sql, tenant, plan, tenant.userId);
  const stub = stubGoogleImage(sql, tenant.organizationId, "ready");
  try {
    await executeApprovedCreativePlan(sql, { organizationId: tenant.organizationId, role: "member" }, tenant.userId, plan);
  } finally {
    stub.restore();
  }
  const [job] = await jobsOf(sql, plan.id);
  assert.ok(job);
  const before = await sql<{ creatives: number; decisions: number }>`
    select (select count(*)::int from creative_records where organization_id = ${tenant.organizationId}) as creatives,
           (select count(*)::int from jev_decisions where organization_id = ${tenant.organizationId} and subject_type = 'creative') as decisions
  `;
  const again = await completeProductionJob(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, productionJobId: job.id });
  assert.equal(again.alreadyMaterialized, true);
  const after = await sql<{ creatives: number; decisions: number }>`
    select (select count(*)::int from creative_records where organization_id = ${tenant.organizationId}) as creatives,
           (select count(*)::int from jev_decisions where organization_id = ${tenant.organizationId} and subject_type = 'creative') as decisions
  `;
  assert.deepEqual(after[0], before[0]);
});

test("the poller materializes a completed image job it finds unmaterialized, from the plan snapshot and not the edited brief", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "durable-poll");
  const plan = imagePlan(tenant.decisionId, { maxSpendUsd: 0.5 });
  // No approver yet, so the Studio cannot materialize the artifact: the job completes and waits for the poller.
  await insertExecutingPlan(sql, tenant, plan, null);
  const stub = stubGoogleImage(sql, tenant.organizationId, "ready");
  try {
    await executeApprovedCreativePlan(sql, { organizationId: tenant.organizationId, role: "member" }, tenant.userId, plan).catch(() => undefined);
  } finally {
    stub.restore();
  }
  const pending = await jobsOf(sql, plan.id);
  assert.ok(pending.length > 0 && pending.every((job) => job.status === "COMPLETED" && job.materialized_at == null));

  // The brief is edited after planning. The creative must not change with it.
  await sql`update briefs set title = 'Edited after planning' where id = ${tenant.briefId}`;
  await sql`update creative_plans set approved_by = ${tenant.userId} where id = ${plan.id}`;
  await sql`update production_jobs set next_poll_at = null where creative_plan_id = ${plan.id}`;

  await pollProductionJobs(sql, { limit: 50 });

  const materialized = await jobsOf(sql, plan.id);
  assert.ok(materialized.every((job) => job.materialized_at != null), "the poller materialized every image job");
  const creatives = await sql<{ title: string }>`
    select title from creative_records where organization_id = ${tenant.organizationId}
  `;
  assert.ok(creatives.length >= plan.deliverables.length);
  assert.ok(creatives.every((row) => !row.title.includes("Edited after planning")), "the creative keeps the plan's snapshot");
  assert.ok(creatives.some((row) => row.title.startsWith(TEST_PRODUCTION_CONTEXT.title)), "the title comes from the plan's production context");
});

test("materialization re-reads the stored bytes and refuses bytes that do not match the recorded checksum", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "durable-tamper");
  const plan = imagePlan(tenant.decisionId, { maxSpendUsd: 0.5 });
  // No approver yet: the job completes with its artifact stored, and waits for materialization.
  await insertExecutingPlan(sql, tenant, plan, null);
  const stub = stubGoogleImage(sql, tenant.organizationId, "ready");
  try {
    await executeApprovedCreativePlan(sql, { organizationId: tenant.organizationId, role: "member" }, tenant.userId, plan).catch(() => undefined);
  } finally {
    stub.restore();
  }
  const [job] = await jobsOf(sql, plan.id);
  assert.equal(job?.status, "COMPLETED");
  await sql`update creative_plans set approved_by = ${tenant.userId} where id = ${plan.id}`;

  // The store hands back different bytes for the same object: a corrupted or substituted artifact.
  const tampered = new Uint8Array(PNG);
  tampered[tampered.length - 1] ^= 0xff;
  const tamperingDrive = {
    put: async () => {
      throw new Error("not used by materialization");
    },
    get: async () => ({ bytes: tampered, mimeType: "image/png", name: "tampered.png" }),
  };
  try {
    await assert.rejects(
      materializeImageArtifact(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, productionJobId: job!.id }, { driveClient: tamperingDrive as never }),
      /do not match the verified artifact/,
    );
    assert.equal((await jobsOf(sql, plan.id))[0]?.materialized_at, null, "nothing is materialized from bytes that fail verification");
  } finally {
    // The poller is database-wide, so this test releases the completed jobs it leaves unmaterialized.
    await sql`update production_jobs set status = 'CANCELLED', error_code = 'released by test' where creative_plan_id = ${plan.id}`;
  }
});

test("the poller never resubmits an image: a job interrupted around its provider call is marked ambiguous, not retried", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "durable-interrupt");
  const jobId = `img-interrupted-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await sql`
    insert into production_jobs (id, organization_id, brand_id, provider, status, cost_mode, input, created_at, updated_at, modality)
    values (${jobId}, ${tenant.organizationId}, ${tenant.brandId}, 'google_nano_banana', 'SUBMITTING', 'BALANCED', '{}', now(), now(), 'image')
  `;
  await pollProductionJobs(sql, { limit: 50 });
  const [row] = await sql<{ status: string; error_code: string | null }>`
    select status, error_code from production_jobs where id = ${jobId}
  `;
  assert.equal(row?.status, "SUBMISSION_UNKNOWN", "the call may have been made, so the job is ambiguous");
  assert.equal(row?.error_code, "INTERRUPTED_IMAGE_SUBMISSION");
});
