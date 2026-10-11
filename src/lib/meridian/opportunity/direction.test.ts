import assert from "node:assert/strict";
import test from "node:test";
import { getSql } from "../../db.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { seedOpportunity } from "../testing/opportunity-fixtures.ts";
import { enableAppAliases } from "../testing/module-aliases.ts";
import { MIN_DIRECTION_REASON_LENGTH } from "../studio/brief-service.contract.ts";

enableAppAliases();
const { recordOpportunityDirection } = await import("./actions.ts");

// Counted once here: the first is exactly twenty characters, the second exactly nineteen.
const TWENTY = "Nineteen char reason";
const NINETEEN = "Nineteen char reaso";
if (TWENTY.length !== MIN_DIRECTION_REASON_LENGTH || NINETEEN.length !== MIN_DIRECTION_REASON_LENGTH - 1) {
  throw new Error("The fixture reasons do not have the lengths the test names them for.");
}

async function directionCount(sql: Awaited<ReturnType<typeof getSql>>, brandId: string): Promise<number> {
  const [row] = await sql<{ count: number }>`
    select count(*)::int as count from opportunity_direction_decisions where brand_id = ${brandId}
  `;
  return row?.count ?? -1;
}

test("a member records an approval with a 20-character reason: who, when, what and why are stored, and the brief and the reviewer decision do not change", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "direction-approve");
  const opportunity = await seedOpportunity(sql, tenant, { outcome: "HUMAN_REVIEW" });
  const result = await recordOpportunityDirection(sql, {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    opportunityId: opportunity.opportunityId,
    actorId: tenant.userId,
    actorRole: "member",
    action: "approve",
    reason: `  ${TWENTY}  `,
  });
  assert.equal(result.opportunityStatus, "accepted");

  const [direction] = await sql<{ actor_id: string; actor_role: string; action: string; reason: string; created_at: unknown }>`
    select actor_id, actor_role, action, reason, created_at from opportunity_direction_decisions where id = ${result.directionId}
  `;
  assert.equal(direction?.actor_id, tenant.userId, "who");
  assert.equal(direction?.actor_role, "member");
  assert.equal(direction?.action, "approve", "what");
  assert.equal(direction?.reason, TWENTY, "why, trimmed");
  assert.ok(direction?.created_at, "when");

  const [hold] = await sql<{ status: string }>`select status from reviews where opportunity_id = ${opportunity.opportunityId}`;
  assert.equal(hold?.status, "approved", "the review hold follows the direction");
  const [audit] = await sql<{ action: string; actor_id: string }>`
    select action, actor_id from audit_log where object_id = ${opportunity.opportunityId} and action = 'opportunity.direction.approve'
  `;
  assert.equal(audit?.actor_id, tenant.userId, "the audit row names the actor");

  // A direction is not a brief decision, so the brief keeps its status and the decision keeps its reviewer fields.
  const [brief] = await sql<{ status: string }>`select status from briefs where id = ${tenant.briefId}`;
  assert.equal(brief?.status, "ready", "the brief status is unchanged");
  const [decision] = await sql<{ reviewer_decision: string | null; reviewer_id: string | null }>`
    select reviewer_decision, reviewer_id from jev_decisions where id = ${opportunity.decisionId}
  `;
  assert.equal(decision?.reviewer_decision, null, "jev_decisions.reviewer_decision is not written by a direction");
  assert.equal(decision?.reviewer_id, null);
  const [reviews] = await sql<{ count: number }>`select count(*)::int as count from decision_reviews where decision_id = ${opportunity.decisionId}`;
  assert.equal(reviews?.count, 0, "no brief review is recorded by a direction");
});

test("a 19-character reason is refused, even when spaces pad it to a longer string, and nothing is written", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "direction-short");
  const opportunity = await seedOpportunity(sql, tenant, { outcome: "HUMAN_REVIEW" });
  for (const reason of [NINETEEN, `   ${NINETEEN}   `]) {
    await assert.rejects(
      recordOpportunityDirection(sql, {
        organizationId: tenant.organizationId,
        brandId: tenant.brandId,
        opportunityId: opportunity.opportunityId,
        actorId: tenant.userId,
        actorRole: "member",
        action: "approve",
        reason,
      }),
      /at least 20 characters/,
    );
  }
  assert.equal(await directionCount(sql, tenant.brandId), 0, "no direction row was written");
  const [hold] = await sql<{ status: string }>`select status from reviews where opportunity_id = ${opportunity.opportunityId}`;
  assert.equal(hold?.status, "open", "the hold is still open");
});

test("a viewer is refused, and so is an unknown role", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "direction-viewer");
  const opportunity = await seedOpportunity(sql, tenant, { outcome: "HUMAN_REVIEW" });
  for (const actorRole of ["viewer", "not-a-role"]) {
    await assert.rejects(
      recordOpportunityDirection(sql, {
        organizationId: tenant.organizationId,
        brandId: tenant.brandId,
        opportunityId: opportunity.opportunityId,
        actorId: tenant.userId,
        actorRole,
        action: "approve",
        reason: TWENTY,
      }),
      /member or higher/,
    );
  }
  assert.equal(await directionCount(sql, tenant.brandId), 0);
});

test("the direction row is append-only: an update and a delete both raise", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "direction-append-only");
  const opportunity = await seedOpportunity(sql, tenant, { outcome: "HUMAN_REVIEW" });
  const result = await recordOpportunityDirection(sql, {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    opportunityId: opportunity.opportunityId,
    actorId: tenant.userId,
    actorRole: "member",
    action: "approve",
    reason: TWENTY,
  });
  await assert.rejects(sql`update opportunity_direction_decisions set reason = 'changed later' where id = ${result.directionId}`, /append-only/);
  await assert.rejects(sql`delete from opportunity_direction_decisions where id = ${result.directionId}`, /append-only/);
  const [row] = await sql<{ reason: string }>`select reason from opportunity_direction_decisions where id = ${result.directionId}`;
  assert.equal(row?.reason, TWENTY, "the stored reason is unchanged");
});

test("the database also refuses a short reason, so a bypass of the code cannot store one", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "direction-db-check");
  const opportunity = await seedOpportunity(sql, tenant, { outcome: "HUMAN_REVIEW" });
  await assert.rejects(
    sql`
      insert into opportunity_direction_decisions (id, organization_id, brand_id, opportunity_id, actor_id, actor_role, action, reason)
      values ('direct-short-1', ${tenant.organizationId}, ${tenant.brandId}, ${opportunity.opportunityId}, ${tenant.userId}, 'member', 'approve', ${NINETEEN})
    `,
    /check/,
  );
});

test("a decline dismisses the opportunity and rejects its hold, and writes no brief decision", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "direction-decline");
  const opportunity = await seedOpportunity(sql, tenant, { outcome: "HUMAN_REVIEW" });
  const result = await recordOpportunityDirection(sql, {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    opportunityId: opportunity.opportunityId,
    actorId: tenant.userId,
    actorRole: "admin",
    action: "decline",
    reason: TWENTY,
  });
  assert.equal(result.opportunityStatus, "dismissed");
  const [hold] = await sql<{ status: string }>`select status from reviews where opportunity_id = ${opportunity.opportunityId}`;
  assert.equal(hold?.status, "rejected");
  const [brief] = await sql<{ status: string }>`select status from briefs where id = ${tenant.briefId}`;
  assert.equal(brief?.status, "ready", "a decline does not touch any brief");
});

test("a rejected, dismissed or already briefed opportunity cannot be accepted", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "direction-closed");
  for (const status of ["rejected", "dismissed", "briefed"]) {
    const opportunity = await seedOpportunity(sql, tenant, { status });
    await assert.rejects(
      recordOpportunityDirection(sql, {
        organizationId: tenant.organizationId,
        brandId: tenant.brandId,
        opportunityId: opportunity.opportunityId,
        actorId: tenant.userId,
        actorRole: "member",
        action: "approve",
        reason: TWENTY,
      }),
      /cannot be decided now/,
      `an opportunity with status ${status} is refused`,
    );
  }
  assert.equal(await directionCount(sql, tenant.brandId), 0);
});

test("another brand's opportunity is not found, so a direction cannot be recorded across tenants", async () => {
  const sql = await getSql();
  const mine = await studioTenant(sql, "direction-tenant-a");
  const theirs = await studioTenant(sql, "direction-tenant-b");
  const opportunity = await seedOpportunity(sql, theirs, { outcome: "HUMAN_REVIEW" });
  await assert.rejects(
    recordOpportunityDirection(sql, {
      organizationId: mine.organizationId,
      brandId: mine.brandId,
      opportunityId: opportunity.opportunityId,
      actorId: mine.userId,
      actorRole: "member",
      action: "approve",
      reason: TWENTY,
    }),
    /not found/,
  );
  assert.equal(await directionCount(sql, mine.brandId), 0);
});
