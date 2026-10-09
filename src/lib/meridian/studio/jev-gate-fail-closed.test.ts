import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import { CreativeDecisionEngine } from "../creative/engine.ts";
import type { Sql } from "../learning/store.ts";
import { executeApprovedCreativePlan, generateStudioVariants } from "./session.server.ts";
import { TEST_PLAN_LINEAGE } from "../testing/plan-lineage.ts";

/**
 * M2 regression: the JEV gate must fail closed before any write or billable generation.
 * A null decision id, a decision row that is missing or belongs to another brand, and a
 * REJECT decision all refuse production. None of these may be skipped silently.
 */

type DecisionMode = { kind: "none" } | { kind: "missing" } | { kind: "row"; decision: string };

/** Runs `run` with production runtime variables, then restores the prior values. */
async function inProduction<T>(run: () => Promise<T>): Promise<T> {
  const prior = { NODE_ENV: process.env.NODE_ENV, MERIDIAN_TESTING_RUNTIME: process.env.MERIDIAN_TESTING_RUNTIME };
  process.env.NODE_ENV = "production";
  delete process.env.MERIDIAN_TESTING_RUNTIME;
  try {
    return await run();
  } finally {
    if (prior.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prior.NODE_ENV;
    if (prior.MERIDIAN_TESTING_RUNTIME === undefined) delete process.env.MERIDIAN_TESTING_RUNTIME;
    else process.env.MERIDIAN_TESTING_RUNTIME = prior.MERIDIAN_TESTING_RUNTIME;
  }
}

async function tenant(sql: Sql, label: string, mode: DecisionMode) {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userId = `user-jev-${suffix}`;
  const organizationId = `org-jev-${suffix}`;
  const brandId = `brand-jev-${suffix}`;
  const otherBrandId = `brand-jev-other-${suffix}`;
  const briefId = `brief-jev-${suffix}`;
  const decisionId = `jev-jev-${suffix}`;
  await sql`insert into "user" (id, name, email, "emailVerified") values (${userId}, 'Fixture User', ${`${userId}@fixture.example`}, true)`;
  await sql`insert into organizations (id, name, slug, created_by) values (${organizationId}, ${organizationId}, ${organizationId}, ${userId})`;
  await sql`insert into memberships (id, organization_id, user_id, role) values (${`mem-${suffix}`}, ${organizationId}, ${userId}, 'member')`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${organizationId}, ${brandId}, ${userId})`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${otherBrandId}, ${organizationId}, ${otherBrandId}, ${userId})`;
  if (mode.kind === "row") {
    await sql`
      insert into jev_decisions (
        id, organization_id, brand_id, correlation_id, question_id, question_version, subject_type, subject_id,
        input, evidence, probability, confidence, thresholds, decision, reasons
      ) values (
        ${decisionId}, ${organizationId}, ${brandId}, ${briefId}, 'opportunity_gate.v2', '2', 'brief', ${briefId},
        '{}', '[]', 0.95, 0.9, '{}', ${mode.decision}, '[]'
      )
    `;
  }
  const storedDecisionId = mode.kind === "none" ? null : decisionId;
  await sql`
    insert into briefs (
      id, organization_id, brand_id, title, angle, hook, format, context_pack, workflow, why, status, decision_id, created_by
    ) values (
      ${briefId}, ${organizationId}, ${brandId}, 'Kitchen sponge', 'live demonstration', 'Tired of smelly sponges?',
      'image', '{}', '{}', 'fixture', 'ready', ${storedDecisionId}, ${userId}
    )
  `;
  const brief = { id: briefId, brand_id: brandId, opportunity_id: null, title: "Kitchen sponge", audience: "", angle: "live demonstration", decision_id: storedDecisionId };
  return { userId, organizationId, brandId, briefId, decisionId: storedDecisionId, brief };
}

async function count(sql: Sql, table: "creative_plans" | "generation_runs" | "budget_reservations", brandId: string) {
  const rows = table === "creative_plans"
    ? await sql<{ count: number }>`select count(*)::int as count from creative_plans where brand_id = ${brandId}`
    : table === "generation_runs"
      ? await sql<{ count: number }>`select count(*)::int as count from generation_runs where brand_id = ${brandId}`
      : await sql<{ count: number }>`select count(*)::int as count from budget_reservations where brand_id = ${brandId}`;
  return Number(rows[0]?.count ?? 0);
}

test("generateStudioVariants refuses a brief with a null JEV decision before any write or provider call", async () => {
  const sql = await getSql();
  const fixture = await tenant(sql, "null-decision", { kind: "none" });
  await inProduction(async () => {
    await assert.rejects(
      generateStudioVariants(fixture.userId, {
        brandId: fixture.brandId,
        briefId: fixture.briefId,
        imageProvider: "google:nano-banana",
        videoProvider: "none",
      }),
      /Brief has no JEV decision/,
    );
  });
  assert.equal(await count(sql, "creative_plans", fixture.brandId), 0, "no plan may be persisted");
  assert.equal(await count(sql, "generation_runs", fixture.brandId), 0, "no generation run may start");
  assert.equal(await count(sql, "budget_reservations", fixture.brandId), 0, "no budget may be reserved");
});

test("generateStudioVariants refuses when the brief's JEV decision row is missing", async () => {
  const sql = await getSql();
  const fixture = await tenant(sql, "missing-row", { kind: "missing" });
  await inProduction(async () => {
    await assert.rejects(
      generateStudioVariants(fixture.userId, {
        brandId: fixture.brandId,
        briefId: fixture.briefId,
        imageProvider: "google:nano-banana",
        videoProvider: "none",
      }),
      /JEV decision for this brief was not found/,
    );
  });
  assert.equal(await count(sql, "creative_plans", fixture.brandId), 0, "no plan may be persisted");
  assert.equal(await count(sql, "budget_reservations", fixture.brandId), 0, "no budget may be reserved");
});

test("generateStudioVariants refuses a JEV decision that belongs to another brand in the same organization", async () => {
  const sql = await getSql();
  const fixture = await tenant(sql, "cross-brand", { kind: "row", decision: "AUTO_APPROVE" });
  // The decision row exists in the same organization, but it was produced for a sibling brand.
  const siblingRows = await sql<{ id: string }>`select id from brands where organization_id = ${fixture.organizationId} and id <> ${fixture.brandId} limit 1`;
  await sql`update jev_decisions set brand_id = ${siblingRows[0].id} where id = ${fixture.decisionId}`;
  await inProduction(async () => {
    await assert.rejects(
      generateStudioVariants(fixture.userId, {
        brandId: fixture.brandId,
        briefId: fixture.briefId,
        imageProvider: "google:nano-banana",
        videoProvider: "none",
      }),
      /JEV decision for this brief was not found/,
    );
  });
  assert.equal(await count(sql, "creative_plans", fixture.brandId), 0, "no plan may be persisted");
});

test("generateStudioVariants refuses a REJECT decision before any write", async () => {
  const sql = await getSql();
  const fixture = await tenant(sql, "reject", { kind: "row", decision: "REJECT" });
  await inProduction(async () => {
    await assert.rejects(
      generateStudioVariants(fixture.userId, {
        brandId: fixture.brandId,
        briefId: fixture.briefId,
        imageProvider: "google:nano-banana",
        videoProvider: "none",
      }),
      /JEV policy rejected this brief/,
    );
  });
  assert.equal(await count(sql, "creative_plans", fixture.brandId), 0, "no plan may be persisted");
});

test("executeApprovedCreativePlan refuses an approved plan whose brief has no JEV decision, and closes the plan", async () => {
  const sql = await getSql();
  const fixture = await tenant(sql, "exec-null", { kind: "none" });
  const plan = CreativeDecisionEngine.createPlan({
    lineage: TEST_PLAN_LINEAGE,
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
    },
    constraints: {},
  });
  await sql`
    insert into creative_plans (
      id, organization_id, brand_id, brief_id, version, status, scope, autonomy, objective, plan_payload, budget_reserved_usd, spend_cap_usd, decision_id
    ) values (
      ${plan.id}, ${fixture.organizationId}, ${fixture.brandId}, ${fixture.briefId}, ${plan.version}, 'executing', ${plan.scope},
      ${plan.autonomy}, ${plan.objective}, ${JSON.stringify(plan)}, 0, null, ${plan.lineage.decisionId}
    )
  `;
  await inProduction(async () => {
    await assert.rejects(
      executeApprovedCreativePlan(sql, { organizationId: fixture.organizationId, role: "member" }, fixture.userId, plan, fixture.brief),
      /Brief has no JEV decision/,
    );
  });
  const rows = await sql<{ status: string }>`select status from creative_plans where id = ${plan.id}`;
  assert.equal(rows[0]?.status, "failed", "the approved plan must not stay in executing after a gate refusal");
  assert.equal(await count(sql, "budget_reservations", fixture.brandId), 0, "no budget may be reserved");
  assert.equal(await count(sql, "generation_runs", fixture.brandId), 0, "no generation run may start");
});
