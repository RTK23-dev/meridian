import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import { CreativeDecisionEngine } from "../creative/engine.ts";
import type { Sql } from "../learning/store.ts";
import { executeApprovedCreativePlan, generateStudioVariants } from "./session.server.ts";
import { TEST_PLAN_LINEAGE, TEST_PRODUCTION_CONTEXT } from "../testing/plan-lineage.ts";

/** Runs `run` with the given runtime variables, then restores the prior values. */
async function withRuntime<T>(
  runtime: { NODE_ENV: string | undefined; MERIDIAN_TESTING_RUNTIME: string | undefined },
  run: () => Promise<T>,
): Promise<T> {
  const prior = { NODE_ENV: process.env.NODE_ENV, MERIDIAN_TESTING_RUNTIME: process.env.MERIDIAN_TESTING_RUNTIME };
  const apply = (name: "NODE_ENV" | "MERIDIAN_TESTING_RUNTIME", value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  apply("NODE_ENV", runtime.NODE_ENV);
  apply("MERIDIAN_TESTING_RUNTIME", runtime.MERIDIAN_TESTING_RUNTIME);
  try {
    return await run();
  } finally {
    apply("NODE_ENV", prior.NODE_ENV);
    apply("MERIDIAN_TESTING_RUNTIME", prior.MERIDIAN_TESTING_RUNTIME);
  }
}

async function studioTenant(sql: Sql, label: string) {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userId = `user-img-${suffix}`;
  const organizationId = `org-img-${suffix}`;
  const brandId = `brand-img-${suffix}`;
  const briefId = `brief-img-${suffix}`;
  const decisionId = `jev-img-${suffix}`;
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
  const brief = { id: briefId, brand_id: brandId, opportunity_id: null, title: "Kitchen sponge", audience: "", angle: "live demonstration", decision_id: decisionId };
  return { userId, organizationId, brandId, briefId, decisionId, brief };
}

async function countCreatives(sql: Sql, brandId: string) {
  const rows = await sql<{ count: number }>`select count(*)::int as count from creative_records where brand_id = ${brandId}`;
  return Number(rows[0]?.count ?? 0);
}

async function countPlans(sql: Sql, brandId: string) {
  const rows = await sql<{ count: number }>`select count(*)::int as count from creative_plans where brand_id = ${brandId}`;
  return Number(rows[0]?.count ?? 0);
}

async function countGenerationJobs(sql: Sql, brandId: string) {
  const rows = await sql<{ count: number }>`select count(*)::int as count from generation_jobs where brand_id = ${brandId}`;
  return Number(rows[0]?.count ?? 0);
}

test("generateStudioVariants refuses the placeholder image provider outside TestingRuntime, before any write", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "refuse");
  await withRuntime({ NODE_ENV: "production", MERIDIAN_TESTING_RUNTIME: undefined }, async () => {
    await assert.rejects(
      generateStudioVariants(tenant.userId, {
        brandId: tenant.brandId,
        briefId: tenant.briefId,
        imageProvider: "test:image",
        videoProvider: "none",
      }),
      /isolated to TestingRuntime/,
    );
  });
  assert.equal(await countPlans(sql, tenant.brandId), 0, "no plan may be created");
  assert.equal(await countGenerationJobs(sql, tenant.brandId), 0, "no generation job may be recorded");
  assert.equal(await countCreatives(sql, tenant.brandId), 0, "no creative may be stored");
});

test("executeApprovedCreativePlan refuses to generate placeholder images outside TestingRuntime", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "executor");
  const plan = CreativeDecisionEngine.createPlan({
    lineage: { decisionId: tenant.decisionId, evidenceRefs: TEST_PLAN_LINEAGE.evidenceRefs },
    productionContext: TEST_PRODUCTION_CONTEXT,
    scope: "image_only",
    autonomy: "semi_automatic",
    preferredImageProvider: "test:image",
    brief: {
      title: "Kitchen sponge",
      hook: "Tired of smelly sponges?",
      message: "Swipe to see the antibacterial mesh layer",
      cta: "Grab a 4-pack today",
      angle: "live demonstration",
      productName: "Mesh sponge",
      aspectRatio: "9:16",
      decisionId: tenant.decisionId,
    },
    constraints: {},
  });
  assert.ok(plan.deliverables.length > 0 && plan.deliverables.every((d) => d.provider === "test:image"));
  await sql`
    insert into creative_plans (
      id, organization_id, brand_id, brief_id, version, status, scope, autonomy, objective, plan_payload, budget_reserved_usd, spend_cap_usd, decision_id
    ) values (
      ${plan.id}, ${tenant.organizationId}, ${tenant.brandId}, ${tenant.briefId}, ${plan.version}, 'executing', ${plan.scope},
      ${plan.autonomy}, ${plan.objective}, ${JSON.stringify(plan)}, 0, null, ${plan.lineage.decisionId}
    )
  `;

  await withRuntime({ NODE_ENV: "production", MERIDIAN_TESTING_RUNTIME: undefined }, async () => {
    await assert.rejects(
      executeApprovedCreativePlan(sql, { organizationId: tenant.organizationId, role: "member" }, tenant.userId, plan),
      /test image provider is not enabled/,
    );
  });
  assert.equal(await countCreatives(sql, tenant.brandId), 0, "a placeholder must not be stored as a creative");
});

test("executeApprovedCreativePlan still generates placeholder images in TestingRuntime", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "control");
  const plan = CreativeDecisionEngine.createPlan({
    lineage: { decisionId: tenant.decisionId, evidenceRefs: TEST_PLAN_LINEAGE.evidenceRefs },
    productionContext: TEST_PRODUCTION_CONTEXT,
    scope: "image_only",
    autonomy: "semi_automatic",
    preferredImageProvider: "test:image",
    brief: {
      title: "Kitchen sponge",
      hook: "Tired of smelly sponges?",
      message: "Swipe to see the antibacterial mesh layer",
      cta: "Grab a 4-pack today",
      angle: "live demonstration",
      productName: "Mesh sponge",
      aspectRatio: "9:16",
      decisionId: tenant.decisionId,
    },
    constraints: {},
  });
  await sql`
    insert into creative_plans (
      id, organization_id, brand_id, brief_id, version, status, scope, autonomy, objective, plan_payload, budget_reserved_usd, spend_cap_usd, decision_id, approved_by
    ) values (
      ${plan.id}, ${tenant.organizationId}, ${tenant.brandId}, ${tenant.briefId}, ${plan.version}, 'executing', ${plan.scope},
      ${plan.autonomy}, ${plan.objective}, ${JSON.stringify(plan)}, 0, null, ${plan.lineage.decisionId}, ${tenant.userId}
    )
  `;

  await withRuntime({ NODE_ENV: undefined, MERIDIAN_TESTING_RUNTIME: "true" }, async () => {
    await executeApprovedCreativePlan(sql, { organizationId: tenant.organizationId, role: "member" }, tenant.userId, plan);
  });
  assert.equal(await countCreatives(sql, tenant.brandId), plan.deliverables.length);
});
