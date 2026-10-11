import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { CreativeDecisionEngine } from "../creative/engine.ts";
import type { CreativePlan } from "../creative/plan.ts";
import { productionRouter } from "../production/router.ts";
import type { CreativeSpec, ProductionJob, ProductionProvider } from "../production/types.ts";
import { BudgetExceededError, BudgetLedgerService, toMicros } from "../security/budget-ledger.ts";
import { executeApprovedCreativePlan } from "./session.server.ts";
import { TEST_PLAN_LINEAGE, TEST_PRODUCTION_CONTEXT } from "../testing/plan-lineage.ts";
import { storeVaultCredential } from "../vault/service.ts";

// The vault encrypts each workspace's saved production key with this master key. Only this test process uses it.
process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY || "test-master-key-reservation-0123456789abcdef";

type Outcome = (spec: CreativeSpec) => Promise<ProductionJob>;

/**
 * Replaces one registered production provider with a stub that inherits everything else
 * from the real adapter. Only health and submission are overridden; the reservation,
 * durable job record, and submission bookkeeping in executeApprovedCreativePlan run as-is.
 */
function injectProvider(providerId: string, outcome: Outcome) {
  const original = productionRouter.get(providerId);
  if (!original) throw new Error(`fixture: provider '${providerId}' is not registered`);
  const submitted: CreativeSpec[] = [];
  const stub = Object.create(original, {
    health: {
      value: async () => ({
        id: providerId,
        state: "HEALTHY",
        capabilities: [],
        detail: "test stub",
        checkedAt: new Date().toISOString(),
      }),
    },
    submitJob: {
      value: async (spec: CreativeSpec) => {
        submitted.push(spec);
        return outcome(spec);
      },
    },
  }) as ProductionProvider;
  productionRouter.register(stub);
  return { submitted, restore: () => productionRouter.register(original) };
}

function job(spec: CreativeSpec, status: ProductionJob["status"], fields: Partial<ProductionJob> = {}): ProductionJob {
  return {
    jobId: `job-${spec.idempotencyKey ?? "fixture"}`,
    organizationId: "",
    brandId: "",
    creativeSpec: spec,
    providerId: spec.providerId ?? "",
    status,
    ...fields,
  } as ProductionJob;
}

async function createTenantFixture(sql: Sql, label: string, planCapUsd: number | null, providerId: string, modelId: string) {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const organizationId = `org-sub-${suffix}`;
  const brandId = `brand-sub-${suffix}`;
  const briefId = `brief-sub-${suffix}`;
  const decisionId = `jev-sub-${suffix}`;
  await sql`insert into organizations (id, name, slug, created_by) values (${organizationId}, ${organizationId}, ${organizationId}, 'test-user')`;
  // The workspace has its own saved production key, so the provider is ready for this workspace through the real readiness check.
  await storeVaultCredential(sql, organizationId, "provider_config:production", { accessToken: "", apiKey: "test-workspace-gemini-key" });
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${organizationId}, ${brandId}, 'test-user')`;
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
      'video', '{}', '{}', 'fixture', 'ready', ${decisionId}, 'test-user'
    )
  `;

  const plan: CreativePlan = CreativeDecisionEngine.createPlan({
    lineage: { decisionId, evidenceRefs: TEST_PLAN_LINEAGE.evidenceRefs },
    productionContext: TEST_PRODUCTION_CONTEXT,
    scope: "video_only",
    autonomy: "semi_automatic",
    preferredVideoProvider: providerId,
    brief: {
      title: "Kitchen sponge",
      hook: "Tired of smelly sponges?",
      message: "Swipe to see the antibacterial mesh layer",
      cta: "Grab a 4-pack today",
      angle: "live demonstration",
      productName: "Mesh sponge",
      aspectRatio: "9:16",
      targetDurationSeconds: 8,
      decisionId,
    },
    constraints: planCapUsd === null ? {} : { maxSpendUsd: planCapUsd },
  });
  if (plan.deliverables.length !== 1 || plan.deliverables[0]!.model !== modelId) {
    throw new Error(`fixture: expected one ${providerId}/${modelId} deliverable, got ${JSON.stringify(plan.deliverables.map((d) => [d.provider, d.model]))}`);
  }

  await sql`
    insert into creative_plans (
      id, organization_id, brand_id, brief_id, version, status, scope, autonomy, objective,
      plan_payload, budget_reserved_usd, spend_cap_usd, decision_id
    ) values (
      ${plan.id}, ${organizationId}, ${brandId}, ${briefId}, ${plan.version}, 'executing', ${plan.scope}, ${plan.autonomy},
      ${plan.objective}, ${JSON.stringify(plan)}, 0, ${planCapUsd}, ${plan.lineage.decisionId}
    )
  `;

  const brief = { id: briefId, brand_id: brandId, opportunity_id: null, title: "Kitchen sponge", audience: "", angle: "live demonstration", decision_id: decisionId };
  return { organizationId, brandId, briefId, plan, brief };
}

async function execute(sql: Sql, tenant: { organizationId: string }, plan: CreativePlan) {
  return executeApprovedCreativePlan(sql, { organizationId: tenant.organizationId, role: "member" }, "test-user", plan);
}

async function reservationsFor(sql: Sql, planId: string) {
  return sql<{ status: string; amount_micros: string | number | bigint }>`
    select status, amount_micros from budget_reservations where creative_plan_id = ${planId} order by created_at
  `;
}

async function accountReservedMicros(sql: Sql, tenant: { organizationId: string; brandId: string }) {
  return (await BudgetLedgerService.getOrCreateAccount(sql, tenant.organizationId, tenant.brandId)).reservedMicros;
}

async function planStatus(sql: Sql, planId: string) {
  const rows = await sql<{ status: string }>`select status from creative_plans where id = ${planId}`;
  return rows[0]?.status;
}

async function productionJobStatus(sql: Sql, tenant: { organizationId: string; brandId: string }) {
  const rows = await sql<{ status: string }>`
    select status from production_jobs where organization_id = ${tenant.organizationId} and brand_id = ${tenant.brandId}
  `;
  return rows.map((row) => row.status);
}

test("ambiguous submission (thrown): the reservation stays held, the job is recorded unknown, and nothing is resubmitted", async () => {
  const sql = await getSql();
  const tenant = await createTenantFixture(sql, "throw", 50, "google_omni", "gemini-omni-1.1-flash");
  const estimateMicros = toMicros(tenant.plan.estimatedCost.totalEstimatedUsd);
  const injected = injectProvider("google_omni", async () => {
    throw new Error("socket hang up after the request was written");
  });
  try {
    await assert.rejects(execute(sql, tenant, tenant.plan), /outcome is unknown/);

    assert.equal(injected.submitted.length, 1, "the provider was called exactly once");
    const reservations = await reservationsFor(sql, tenant.plan.id);
    assert.deepEqual(reservations.map((r) => r.status), ["RESERVED"], "the reservation is still held");
    assert.equal(BigInt(reservations[0]!.amount_micros), estimateMicros);
    assert.equal(await accountReservedMicros(sql, tenant), estimateMicros, "the budget stays reserved");
    assert.deepEqual(await productionJobStatus(sql, tenant), ["SUBMISSION_UNKNOWN"]);
    assert.equal(await planStatus(sql, tenant.plan.id), "failed");

    // The plan is no longer executable, so a retry cannot submit the possibly-billable job again.
    await assert.rejects(execute(sql, tenant, tenant.plan), /must be durably approved and executing/);
    assert.equal(injected.submitted.length, 1, "no resubmission");
  } finally {
    injected.restore();
  }
});

test("ambiguous submission (reported SUBMISSION_UNKNOWN): the reservation stays held", async () => {
  const sql = await getSql();
  const tenant = await createTenantFixture(sql, "reported", 50, "google_omni", "gemini-omni-1.1-flash");
  const estimateMicros = toMicros(tenant.plan.estimatedCost.totalEstimatedUsd);
  const injected = injectProvider("google_omni", async (spec) =>
    job(spec, "SUBMISSION_UNKNOWN", { error: "timed out waiting for acceptance" }),
  );
  try {
    await assert.rejects(execute(sql, tenant, tenant.plan), /outcome is unknown/);

    assert.equal(injected.submitted.length, 1);
    assert.deepEqual((await reservationsFor(sql, tenant.plan.id)).map((r) => r.status), ["RESERVED"]);
    assert.equal(await accountReservedMicros(sql, tenant), estimateMicros);
    assert.deepEqual(await productionJobStatus(sql, tenant), ["SUBMISSION_UNKNOWN"]);
  } finally {
    injected.restore();
  }
});

test("definitive provider rejection: the reservation is released and the budget is free again", async () => {
  const sql = await getSql();
  const tenant = await createTenantFixture(sql, "rejected", 50, "google_omni", "gemini-omni-1.1-flash");
  const injected = injectProvider("google_omni", async (spec) =>
    job(spec, "FAILED", { error: "quota rejected before any work started", errorCode: "QUOTA" }),
  );
  try {
    await assert.rejects(execute(sql, tenant, tenant.plan), /Video production failed/);

    assert.equal(injected.submitted.length, 1);
    assert.deepEqual((await reservationsFor(sql, tenant.plan.id)).map((r) => r.status), ["RELEASED"]);
    assert.equal(await accountReservedMicros(sql, tenant), 0n);
    assert.deepEqual(await productionJobStatus(sql, tenant), ["FAILED"]);
  } finally {
    injected.restore();
  }
});

test("plan spend cap is enforced before any provider call", async () => {
  const sql = await getSql();
  // Estimate is above the plan's own cap. The account default ($100) would allow it.
  const tenant = await createTenantFixture(sql, "cap", 0.5, "google_omni", "gemini-omni-1.1-flash");
  assert.ok(tenant.plan.estimatedCost.totalEstimatedUsd > 0.5, "fixture: estimate must exceed the plan cap");
  const injected = injectProvider("google_omni", async (spec) => job(spec, "QUEUED", { providerJobId: "never" }));
  try {
    await assert.rejects(execute(sql, tenant, tenant.plan), (error: unknown) =>
      error instanceof BudgetExceededError && /CreativePlan spend cap exceeded/.test((error as Error).message),
    );

    assert.equal(injected.submitted.length, 0, "no provider call");
    assert.deepEqual(await reservationsFor(sql, tenant.plan.id), []);
    assert.equal(await accountReservedMicros(sql, tenant), 0n);
    assert.deepEqual(await productionJobStatus(sql, tenant), []);
  } finally {
    injected.restore();
  }
});

test("zero estimate on a billable provider is refused before any provider call", async () => {
  const sql = await getSql();
  const tenant = await createTenantFixture(sql, "zero", 50, "google_omni", "gemini-omni-1.1-flash");
  const plan = { ...tenant.plan, estimatedCost: { ...tenant.plan.estimatedCost, totalEstimatedUsd: 0 } };
  const injected = injectProvider("google_omni", async (spec) => job(spec, "QUEUED", { providerJobId: "never" }));
  try {
    await assert.rejects(execute(sql, tenant, plan), /Zero cost estimate for a billable provider/);

    assert.equal(injected.submitted.length, 0);
    assert.deepEqual(await reservationsFor(sql, tenant.plan.id), []);
    assert.equal(await accountReservedMicros(sql, tenant), 0n);
  } finally {
    injected.restore();
  }
});

test("missing estimate on a billable provider is refused before any provider call", async () => {
  const sql = await getSql();
  const tenant = await createTenantFixture(sql, "missing", 50, "google_omni", "gemini-omni-1.1-flash");
  const plan = { ...tenant.plan, estimatedCost: undefined } as unknown as CreativePlan;
  const injected = injectProvider("google_omni", async (spec) => job(spec, "QUEUED", { providerJobId: "never" }));
  try {
    await assert.rejects(execute(sql, tenant, plan), /Cost estimate is missing or invalid/);

    assert.equal(injected.submitted.length, 0);
    assert.deepEqual(await reservationsFor(sql, tenant.plan.id), []);
  } finally {
    injected.restore();
  }
});

test("non-finite estimate on a billable provider is refused before any provider call", async () => {
  const sql = await getSql();
  const tenant = await createTenantFixture(sql, "nan", 50, "google_omni", "gemini-omni-1.1-flash");
  const plan = { ...tenant.plan, estimatedCost: { ...tenant.plan.estimatedCost, totalEstimatedUsd: Number.NaN } };
  const injected = injectProvider("google_omni", async (spec) => job(spec, "QUEUED", { providerJobId: "never" }));
  try {
    await assert.rejects(execute(sql, tenant, plan), /Cost estimate is missing or invalid/);

    assert.equal(injected.submitted.length, 0);
    assert.deepEqual(await reservationsFor(sql, tenant.plan.id), []);
  } finally {
    injected.restore();
  }
});

test("zero estimate is accepted only when the registry establishes the provider as free", async () => {
  const sql = await getSql();
  const tenant = await createTenantFixture(sql, "free", null, "manual_cloud", "manual-cloud");
  const plan = { ...tenant.plan, estimatedCost: { ...tenant.plan.estimatedCost, totalEstimatedUsd: 0 } };
  const injected = injectProvider("manual_cloud", async (spec) => job(spec, "QUEUED", { providerJobId: "drop-1" }));
  try {
    await execute(sql, tenant, plan);

    assert.equal(injected.submitted.length, 1, "the registry-free provider is called");
    assert.deepEqual(await reservationsFor(sql, tenant.plan.id), [], "no reservation is needed for a free provider");
    assert.equal(await accountReservedMicros(sql, tenant), 0n);
  } finally {
    injected.restore();
  }
});

test("artifact finalization failure after a completed submission records its error in the real production_jobs schema", async () => {
  const sql = await getSql();
  const tenant = await createTenantFixture(sql, "finalize", 50, "google_omni", "gemini-omni-1.1-flash");
  // COMPLETED with no bytes and no artifact URI: the finalizer returns WAITING_FOR_ARTIFACT,
  // which drives the storage-persistence failure branch of the executor.
  const injected = injectProvider("google_omni", async (spec) => job(spec, "COMPLETED", { providerJobId: "omni-1" }));
  try {
    await execute(sql, tenant, tenant.plan);

    assert.equal(injected.submitted.length, 1);
    const rows = await sql<{ status: string; error_message: string | null }>`
      select status, error_message from production_jobs
      where organization_id = ${tenant.organizationId} and brand_id = ${tenant.brandId}
    `;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, "WAITING_FOR_ARTIFACT");
    assert.match(rows[0]!.error_message ?? "", /Artifact media bytes are not available/);
  } finally {
    injected.restore();
  }
});
