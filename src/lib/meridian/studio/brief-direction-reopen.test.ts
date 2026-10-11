import assert from "node:assert/strict";
import test from "node:test";
import { createPoolSql, getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { failingSql, seedOpportunity } from "../testing/opportunity-fixtures.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { BRAIN, BRIEF, approvesBriefCalibrated, registryWith, stubEngine } from "../testing/brief-fixtures.ts";
import { enableAppAliases } from "../testing/module-aliases.ts";
import { briefGateJudge, createGatedBrief, type BriefGateOptions } from "./brief-service.server.ts";
import type { BriefRecord } from "./brief-service.contract.ts";
import type { BriefForGate } from "./brief-gate.server.ts";
import { reviewBrief } from "./brief-review.server.ts";

// The direction helper lives beside the opportunity actions, which use the "@/" alias.
enableAppAliases();
const { recordOpportunityDirection } = await import("../opportunity/actions.ts");

const PG_TEST_URL = process.env.MERIDIAN_PG_TEST_URL?.trim();
const DIRECTION_REASON = "The stored competitor evidence supports this direction for the brief.";
const REVIEW_REASON = "Reviewed the disclosed failure. The brand fit is clear from the positioning and the copy.";
/** A brief with no hook is refused by the deterministic checks, so no engine is asked and the outcome is REJECT. */
const REJECTED_BRIEF: BriefForGate = { ...BRIEF, hook: "" };

function approveGate(): BriefGateOptions {
  return {
    engines: registryWith(stubEngine("jev", { respond: approvesBriefCalibrated }), stubEngine("openai-decisions")),
    selection: { engineId: "jev", source: "workspace" },
  };
}

/** A provider failure on the selected engine leaves the brief in human review. */
function reviewGate(): BriefGateOptions {
  return {
    engines: registryWith(stubEngine("jev"), stubEngine("openai-decisions", { failure: true })),
    selection: { engineId: "openai-decisions", source: "workspace" },
  };
}

function briefRecord(opportunityId: string, brief: BriefForGate): BriefRecord {
  return {
    opportunityId,
    title: "Direction brief",
    audience: brief.audience,
    angle: brief.angle,
    hook: brief.hook,
    message: brief.message,
    offer: "",
    cta: brief.cta,
    format: brief.format,
    proofType: "",
    constraints: "",
    context: {},
    workflow: "test",
    why: [],
    learningNotes: [],
    failureNotes: [],
  };
}

async function opportunityStatus(sql: Sql, id: string): Promise<string | undefined> {
  const [row] = await sql<{ status: string }>`select status from opportunities where id = ${id}`;
  return row?.status;
}

async function briefStatus(sql: Sql, id: string): Promise<string | undefined> {
  const [row] = await sql<{ status: string }>`select status from briefs where id = ${id}`;
  return row?.status;
}

async function reopenCount(sql: Sql, opportunityId: string): Promise<number> {
  const [row] = await sql<{ count: number }>`
    select count(*)::int as count from audit_log where object_id = ${opportunityId} and action = 'opportunity.direction.reopened'
  `;
  return row?.count ?? 0;
}

async function accept(sql: Sql, tenant: { organizationId: string; brandId: string; userId: string }, opportunityId: string) {
  await recordOpportunityDirection(sql, {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    opportunityId,
    actorId: tenant.userId,
    actorRole: "member",
    action: "approve",
    reason: DIRECTION_REASON,
  });
}

async function writeBrief(
  sql: Sql,
  tenant: { organizationId: string; brandId: string; userId: string },
  opportunityId: string,
  gate: BriefGateOptions,
  brief: BriefForGate = BRIEF,
) {
  const judge = briefGateJudge(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, brief, brain: BRAIN, ...gate });
  return createGatedBrief(sql, {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    createdBy: tenant.userId,
    brief: briefRecord(opportunityId, brief),
    judge,
  });
}

/** A rejected brief leaves its accepted direction open. The approval itself stays on record, and the reopen is audited. */
async function rejectedBriefReopensDirection(sql: Sql) {
  const tenant = await studioTenant(sql, `reopen-${Math.random().toString(36).slice(2, 7)}`);
  const { opportunityId } = await seedOpportunity(sql, tenant);
  await accept(sql, tenant, opportunityId);
  assert.equal(await opportunityStatus(sql, opportunityId), "accepted");
  const made = await writeBrief(sql, tenant, opportunityId, approveGate(), REJECTED_BRIEF);
  assert.equal(made.status, "rejected");
  assert.equal(await opportunityStatus(sql, opportunityId), "open", "the opportunity is no longer accepted");
  assert.equal(await reopenCount(sql, opportunityId), 1, "the reopen is audited once");
  const [direction] = await sql<{ action: string }>`
    select action from opportunity_direction_decisions where opportunity_id = ${opportunityId}
  `;
  assert.equal(direction?.action, "approve", "the person's approval stays on record");
}

/** A rejected brief does not reopen a direction that a live brief of the same opportunity still rests on. */
async function liveBriefKeepsDirection(sql: Sql) {
  const tenant = await studioTenant(sql, `live-${Math.random().toString(36).slice(2, 7)}`);
  const { opportunityId } = await seedOpportunity(sql, tenant);
  await accept(sql, tenant, opportunityId);
  const first = await writeBrief(sql, tenant, opportunityId, approveGate());
  assert.equal(first.status, "ready");
  assert.equal(await opportunityStatus(sql, opportunityId), "briefed");
  const second = await writeBrief(sql, tenant, opportunityId, approveGate(), REJECTED_BRIEF);
  assert.equal(second.status, "rejected");
  assert.equal(await opportunityStatus(sql, opportunityId), "briefed", "the ready brief still holds the direction");
  assert.equal(await reopenCount(sql, opportunityId), 0);
}

/** A reviewer who rejects a held brief reopens its direction, because the review is the rejection. */
async function reviewRejectionReopensDirection(sql: Sql) {
  const tenant = await studioTenant(sql, `review-reopen-${Math.random().toString(36).slice(2, 7)}`);
  const { opportunityId } = await seedOpportunity(sql, tenant);
  await accept(sql, tenant, opportunityId);
  const held = await writeBrief(sql, tenant, opportunityId, reviewGate());
  assert.equal(held.status, "awaiting_review");
  assert.equal(await opportunityStatus(sql, opportunityId), "briefed");
  const reviewed = await reviewBrief(sql, {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    briefId: held.briefId,
    reviewerId: `admin-${tenant.userId}`,
    reviewerRole: "admin",
    action: "reject",
    reason: REVIEW_REASON,
    acknowledged: true,
  });
  assert.equal(reviewed.briefStatus, "rejected");
  assert.equal(await briefStatus(sql, held.briefId), "rejected");
  assert.equal(await opportunityStatus(sql, opportunityId), "open", "the rejected review reopens the direction");
  assert.equal(await reopenCount(sql, opportunityId), 1);
}

/** The reopen is part of the rejection's transaction: a failure in it leaves no rejected brief and the direction accepted. */
async function reopenFailureRollsBackRejection(sql: Sql) {
  const tenant = await studioTenant(sql, `reopen-atomic-${Math.random().toString(36).slice(2, 7)}`);
  const { opportunityId } = await seedOpportunity(sql, tenant);
  await accept(sql, tenant, opportunityId);
  let judgedBriefId = "";
  const judge = briefGateJudge(sql, {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    brief: REJECTED_BRIEF,
    brain: BRAIN,
    ...approveGate(),
  });
  await assert.rejects(
    createGatedBrief(failingSql(sql, /update opportunities set status = 'open'/), {
      organizationId: tenant.organizationId,
      brandId: tenant.brandId,
      createdBy: tenant.userId,
      brief: briefRecord(opportunityId, REJECTED_BRIEF),
      judge: (briefId) => {
        judgedBriefId = briefId;
        return judge(briefId);
      },
    }),
    /injected write failure/,
  );
  assert.notEqual(judgedBriefId, "");
  const [briefs] = await sql<{ count: number }>`select count(*)::int as count from briefs where id = ${judgedBriefId}`;
  assert.equal(briefs?.count, 0, "the rejected brief was rolled back with the reopen");
  assert.equal(await opportunityStatus(sql, opportunityId), "accepted", "the direction is unchanged after the failed reopen");
}

/** The review's reopen is part of the review's transaction: a failure in it leaves the brief held and the decision unreviewed. */
async function reviewReopenFailureRollsBackReview(sql: Sql) {
  const tenant = await studioTenant(sql, `review-atomic-reopen-${Math.random().toString(36).slice(2, 7)}`);
  const { opportunityId } = await seedOpportunity(sql, tenant);
  await accept(sql, tenant, opportunityId);
  const held = await writeBrief(sql, tenant, opportunityId, reviewGate());
  await assert.rejects(
    reviewBrief(failingSql(sql, /update opportunities set status = 'open'/), {
      organizationId: tenant.organizationId,
      brandId: tenant.brandId,
      briefId: held.briefId,
      reviewerId: `admin-${tenant.userId}`,
      reviewerRole: "admin",
      action: "reject",
      reason: REVIEW_REASON,
      acknowledged: true,
    }),
    /injected write failure/,
  );
  assert.equal(await briefStatus(sql, held.briefId), "awaiting_review", "the brief is still held");
  assert.equal(await opportunityStatus(sql, opportunityId), "briefed", "the direction is unchanged");
  const [decision] = await sql<{ reviewer_decision: string | null }>`select reviewer_decision from jev_decisions where id = ${held.decisionId}`;
  assert.equal(decision?.reviewer_decision, null, "the decision is still unreviewed");
}

const SCENARIOS = [
  ["a rejected brief reopens its accepted direction", rejectedBriefReopensDirection],
  ["a rejected brief does not reopen a direction a live brief still holds", liveBriefKeepsDirection],
  ["a rejected review reopens the direction", reviewRejectionReopensDirection],
  ["a failed reopen rolls back the rejected brief", reopenFailureRollsBackRejection],
  ["a failed reopen rolls back the rejected review", reviewReopenFailureRollsBackReview],
] as const;

for (const [name, scenario] of SCENARIOS) {
  test(`PGlite: ${name}`, async () => {
    await scenario(await getSql());
  });

  test(`PostgreSQL: ${name}`, async (t) => {
    if (!PG_TEST_URL) {
      t.skip("MERIDIAN_PG_TEST_URL is not set, so the PostgreSQL direction check was not run");
      return;
    }
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: PG_TEST_URL });
    try {
      await scenario(createPoolSql(pool));
    } finally {
      await pool.end();
    }
  });
}
