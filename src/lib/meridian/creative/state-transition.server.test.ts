import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import { transitionCreativePlan } from "./state-transition.server.ts";

async function seedPlan(sql: Awaited<ReturnType<typeof getSql>>, status = "awaiting_approval") {
  const id = globalThis.crypto.randomUUID();
  const organizationId = `org-transition-${id}`;
  const brandId = `brand-transition-${id}`;
  await sql`insert into organizations (id, name, slug, created_by) values (${organizationId}, 'Transition Org', ${id}, 'test')`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${organizationId}, 'Transition Brand', 'test')`;
  await sql`
    insert into creative_plans (id, organization_id, brand_id, version, status, scope, autonomy, objective)
    values (${id}, ${organizationId}, ${brandId}, '1', ${status}, 'video_only', 'manual', 'conversion')
  `;
  return { id, planId: id, organizationId, brandId };
}

test("durable CreativePlan approval and execution are distinct, audited transitions", async () => {
  const sql = await getSql();
  const plan = await seedPlan(sql);
  const approved = await transitionCreativePlan(sql, { ...plan, actorId: "reviewer-1", target: "approved" });
  assert.equal(approved.status, "approved");
  const executing = await transitionCreativePlan(sql, { ...plan, actorId: "reviewer-1", target: "executing" });
  assert.equal(executing.status, "executing");
  const completed = await transitionCreativePlan(sql, { ...plan, actorId: "worker-1", target: "completed" });
  assert.equal(completed.status, "completed");

  const rows = await sql<{ action: string }>`
    select action from audit_log where object_type = 'creative_plan' and object_id = ${plan.id} order by created_at
  `;
  assert.deepEqual(rows.map((row) => row.action), [
    "creative_plan.approved", "creative_plan.executing", "creative_plan.completed",
  ]);
});

test("durable CreativePlan transition rejects approval jumps and cross-tenant IDs", async () => {
  const sql = await getSql();
  const plan = await seedPlan(sql);
  await assert.rejects(
    transitionCreativePlan(sql, { ...plan, actorId: "reviewer-1", target: "executing" }),
    /Invalid transition/,
  );
  await assert.rejects(
    transitionCreativePlan(sql, { ...plan, organizationId: "another-tenant", actorId: "reviewer-1", target: "approved" }),
    /not found/,
  );
});

test("duplicate approval transition is idempotent and cannot create duplicate audit lineage", async () => {
  const sql = await getSql();
  const plan = await seedPlan(sql);
  await transitionCreativePlan(sql, { ...plan, actorId: "reviewer-1", target: "approved" });
  const retry = await transitionCreativePlan(sql, { ...plan, actorId: "reviewer-1", target: "approved" });
  assert.equal(retry.alreadyInState, true);
  const rows = await sql<{ count: number }>`
    select count(*)::int as count from audit_log where object_type = 'creative_plan' and object_id = ${plan.id}
  `;
  assert.equal(rows[0].count, 1);
});
