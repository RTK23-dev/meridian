import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import { CreativeDecisionEngine } from "../creative/engine.ts";
import type { CreativePlan } from "../creative/plan.ts";
import type { Sql } from "../learning/store.ts";
import { persistCreativePlanRow } from "./session.server.ts";
import { TEST_PLAN_LINEAGE, TEST_PRODUCTION_CONTEXT } from "../testing/plan-lineage.ts";

async function tenant(sql: Sql, label: string) {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const organizationId = `org-plan-${suffix}`;
  const brandId = `brand-plan-${suffix}`;
  const briefId = `brief-plan-${suffix}`;
  const decisionId = `jev-plan-${suffix}`;
  await sql`insert into organizations (id, name, slug, created_by) values (${organizationId}, ${organizationId}, ${organizationId}, 'test-user')`;
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
      'image', '{}', '{}', 'fixture', 'ready', ${decisionId}, 'test-user'
    )
  `;
  return { organizationId, brandId, briefId, decisionId };
}

function planFor(decisionId: string) {
  return CreativeDecisionEngine.createPlan({
    lineage: TEST_PLAN_LINEAGE,
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
      decisionId,
    },
    constraints: {},
  });
}

test("persistCreativePlanRow inserts a new plan with its own lifecycle status", async () => {
  const sql = await getSql();
  const t = await tenant(sql, "insert");
  const plan = planFor(t.decisionId);
  await persistCreativePlanRow(sql, { plan, organizationId: t.organizationId, brandId: t.brandId, briefId: t.briefId });
  const rows = await sql<{ status: string }>`select status from creative_plans where id = ${plan.id}`;
  assert.equal(rows[0]?.status, plan.status);
});

test("persistCreativePlanRow refuses an id collision and leaves the live plan's lifecycle untouched", async () => {
  const sql = await getSql();
  const t = await tenant(sql, "collision");
  const plan = planFor(t.decisionId);
  await sql`
    insert into creative_plans (
      id, organization_id, brand_id, brief_id, version, status, scope, autonomy, objective, plan_payload, budget_reserved_usd, decision_id
    ) values (
      ${plan.id}, ${t.organizationId}, ${t.brandId}, ${t.briefId}, ${plan.version}, 'executing', ${plan.scope},
      ${plan.autonomy}, ${plan.objective}, ${JSON.stringify(plan)}, 0, ${plan.lineage.decisionId}
    )
  `;
  await assert.rejects(
    persistCreativePlanRow(sql, { plan: { ...plan, status: "awaiting_approval" }, organizationId: t.organizationId, brandId: t.brandId, briefId: t.briefId }),
    /already exists/,
  );
  const rows = await sql<{ status: string }>`select status from creative_plans where id = ${plan.id}`;
  assert.equal(rows[0]?.status, "executing", "a colliding insert must not change the live plan's status");
});

test("persistCreativePlanRow records the decision the plan was produced under", async () => {
  const sql = await getSql();
  const t = await tenant(sql, "lineage");
  const plan = CreativeDecisionEngine.createPlan({
    scope: "video_only",
    autonomy: "semi_automatic",
    brief: { title: "Kitchen sponge", hook: "Tired of smelly sponges?", message: "Mesh layer", cta: "Buy now", targetDurationSeconds: 8 },
    lineage: { decisionId: t.decisionId, evidenceRefs: ["ev-lineage-1"] },
  });
  await persistCreativePlanRow(sql, { plan, organizationId: t.organizationId, brandId: t.brandId, briefId: t.briefId });
  const rows = await sql<{ decision_id: string }>`select decision_id from creative_plans where id = ${plan.id}`;
  assert.equal(rows[0]?.decision_id, t.decisionId);
});

test("persistCreativePlanRow refuses a plan with no lineage and writes no row", async () => {
  const sql = await getSql();
  const t = await tenant(sql, "unlinked");
  const plan = { ...planFor(t.decisionId), lineage: undefined } as unknown as CreativePlan;
  await assert.rejects(
    persistCreativePlanRow(sql, { plan, organizationId: t.organizationId, brandId: t.brandId, briefId: t.briefId }),
    /lineage/,
  );
  const rows = await sql<{ id: string }>`select id from creative_plans where id = ${plan.id}`;
  assert.equal(rows.length, 0);
});
