import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";

async function tenant(sql: Sql) {
  const suffix = randomUUID().slice(0, 8);
  const organizationId = `org-lin-${suffix}`;
  const brandId = `brand-lin-${suffix}`;
  await sql`insert into organizations (id, name, slug, created_by) values (${organizationId}, ${organizationId}, ${organizationId}, 'test-user')`;
  await sql`insert into brands (id, organization_id, name, created_by) values (${brandId}, ${organizationId}, ${brandId}, 'test-user')`;
  return { organizationId, brandId, suffix };
}

test("the database refuses a new creative plan that has no persisted decision id", async () => {
  const sql = await getSql();
  const { organizationId, brandId, suffix } = await tenant(sql);
  await assert.rejects(
    sql`
      insert into creative_plans (id, organization_id, brand_id, version, scope, autonomy, objective, plan_payload)
      values (${`plan-${suffix}`}, ${organizationId}, ${brandId}, '2026.10.1', 'video_only', 'manual', 'conversion', '{}')
    `,
    /creative_plans_decision_lineage/,
  );
});

test("the database accepts a new creative plan that records its decision id", async () => {
  const sql = await getSql();
  const { organizationId, brandId, suffix } = await tenant(sql);
  await sql`
    insert into creative_plans (id, organization_id, brand_id, version, scope, autonomy, objective, plan_payload, decision_id)
    values (${`plan-${suffix}`}, ${organizationId}, ${brandId}, '2026.10.1', 'video_only', 'manual', 'conversion', '{}', ${`jev-${suffix}`})
  `;
  const rows = await sql<{ decision_id: string }>`select decision_id from creative_plans where id = ${`plan-${suffix}`}`;
  assert.equal(rows[0]!.decision_id, `jev-${suffix}`);
});

test("the database refuses a blank decision id, which is not lineage", async () => {
  const sql = await getSql();
  const { organizationId, brandId, suffix } = await tenant(sql);
  await assert.rejects(
    sql`
      insert into creative_plans (id, organization_id, brand_id, version, scope, autonomy, objective, plan_payload, decision_id)
      values (${`plan-${suffix}`}, ${organizationId}, ${brandId}, '2026.10.1', 'video_only', 'manual', 'conversion', '{}', '')
    `,
    /creative_plans_decision_lineage/,
  );
});
