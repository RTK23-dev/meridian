import assert from "node:assert/strict";
import test from "node:test";
import { createPoolSql, getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { requireBrand } from "../brand-membership.ts";
import { studioTenant } from "../../../test-support/lib/meridian/testing/durable-image-fixtures.ts";
import { failingSql } from "../../../test-support/lib/meridian/testing/opportunity-fixtures.ts";
import { enableAppAliases } from "../../../test-support/lib/meridian/testing/module-aliases.ts";

// The action module uses the "@/" alias, so the hook is registered before it is imported.
enableAppAliases();
const { applyReviewDecision } = await import("./actions.ts");

/**
 * The generic review action writes the review, its decision, the creative, the rejection row, the opportunity and the audit row
 * in one transaction, and every statement is scoped to the caller's workspace and brand. These checks run on the default
 * connection (PGlite unless DATABASE_URL is set) and, when MERIDIAN_PG_TEST_URL is set, on PostgreSQL through a pinned pool.
 */
const PG_TEST_URL = process.env.MERIDIAN_PG_TEST_URL?.trim();
const TARGETS = ["default connection", "PostgreSQL pool"] as const;
type Target = (typeof TARGETS)[number];

type Tenant = { userId: string; organizationId: string; brandId: string };
type Links = { reviewId: string; decisionId: string; creativeId: string; opportunityId: string };

async function onTarget(target: Target, t: { skip(message?: string): void }, run: (sql: Sql) => Promise<void>) {
  if (target === "default connection") return run(await getSql());
  if (!PG_TEST_URL) {
    t.skip("MERIDIAN_PG_TEST_URL is not set, so the PostgreSQL run was not made");
    return;
  }
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: PG_TEST_URL });
  try {
    await run(createPoolSql(pool));
  } finally {
    await pool.end();
  }
}

function suffixFor(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function insertDecision(sql: Sql, tenant: Tenant, suffix: string): Promise<string> {
  const decisionId = `jev-txn-${suffix}`;
  await sql`
    insert into jev_decisions (
      id, organization_id, brand_id, correlation_id, question_id, question_version, subject_type, subject_id,
      input, evidence, probability, confidence, thresholds, decision, reasons
    ) values (
      ${decisionId}, ${tenant.organizationId}, ${tenant.brandId}, ${`corr-${suffix}`}, 'opportunity_gate.v2', '2', 'creative', ${`subj-${suffix}`},
      '{}', '[]', 0.6, 0.7, '{}', 'HUMAN_REVIEW', '["fixture reason"]'
    )
  `;
  return decisionId;
}

async function insertCreative(sql: Sql, tenant: Tenant, suffix: string): Promise<string> {
  const creativeId = `cr-txn-${suffix}`;
  await sql`
    insert into creative_records (id, organization_id, brand_id, origin, status, created_by)
    values (${creativeId}, ${tenant.organizationId}, ${tenant.brandId}, 'own', 'in_review', ${tenant.userId})
  `;
  return creativeId;
}

async function insertOpportunity(sql: Sql, tenant: Tenant, suffix: string): Promise<string> {
  const opportunityId = `opp-txn-${suffix}`;
  await sql`
    insert into opportunities (
      id, organization_id, brand_id, hypothesis_id, label, category, angle, hook_type, format,
      market_signal, novelty_score, brand_fit_score, reproducibility_score, risk_score, saturation_score,
      historical_score, expected_value, raw_score, confidence, reason, evidence, evidence_basis
    ) values (
      ${opportunityId}, ${tenant.organizationId}, ${tenant.brandId}, ${`hyp-${suffix}`}, 'Fixture opportunity', 'category', 'angle', 'hook', 'image',
      0.5, 0.5, 0.5, 0.2, 0.2, 0.5, 0.5, 0.5, 0.5, 0.7, 'fixture', '[]', 'fixture'
    )
  `;
  return opportunityId;
}

/** One open review whose decision, creative and opportunity all belong to the tenant's brand. */
async function openReview(sql: Sql, tenant: Tenant, label: string): Promise<Links> {
  const suffix = suffixFor(label);
  const decisionId = await insertDecision(sql, tenant, suffix);
  const creativeId = await insertCreative(sql, tenant, suffix);
  const opportunityId = await insertOpportunity(sql, tenant, suffix);
  const reviewId = `rev-txn-${suffix}`;
  await sql`
    insert into reviews (id, organization_id, brand_id, decision_id, creative_id, opportunity_id, subject_label, status)
    values (${reviewId}, ${tenant.organizationId}, ${tenant.brandId}, ${decisionId}, ${creativeId}, ${opportunityId}, ${label}, 'open')
  `;
  return { reviewId, decisionId, creativeId, opportunityId };
}

/** Every row the action can change, read back as plain values, so two snapshots compare exactly. */
async function snapshot(sql: Sql, links: Links) {
  const [review] = await sql<{ status: string }>`select status from reviews where id = ${links.reviewId}`;
  const [decision] = await sql<{ reviewer_id: string | null; reviewer_decision: string | null; reviewer_note: string; reviewed_at: unknown }>`
    select reviewer_id, reviewer_decision, reviewer_note, reviewed_at from jev_decisions where id = ${links.decisionId}
  `;
  const [creative] = await sql<{ status: string }>`select status from creative_records where id = ${links.creativeId}`;
  const [opportunity] = await sql<{ status: string }>`select status from opportunities where id = ${links.opportunityId}`;
  const rejections = await sql<{ reason_code: string; note: string; rejected_by: string; creative_id: string | null; decision_id: string | null }>`
    select reason_code, note, rejected_by, creative_id, decision_id from rejections where decision_id = ${links.decisionId}
  `;
  const audits = await sql<{ action: string; actor_id: string; organization_id: string; brand_id: string | null; metadata: string }>`
    select action, actor_id, organization_id, brand_id, metadata from audit_log where object_id = ${links.reviewId} order by action
  `;
  return {
    review: review?.status,
    decision: decision
      ? {
          reviewerId: decision.reviewer_id,
          reviewerDecision: decision.reviewer_decision,
          reviewerNote: decision.reviewer_note,
          reviewed: decision.reviewed_at !== null && decision.reviewed_at !== undefined,
        }
      : undefined,
    creative: creative?.status,
    opportunity: opportunity?.status,
    rejections: rejections.map((row) => ({
      reasonCode: row.reason_code,
      note: row.note,
      rejectedBy: row.rejected_by,
      creativeId: row.creative_id,
      decisionId: row.decision_id,
    })),
    audits: audits.map((row) => ({
      action: row.action,
      actorId: row.actor_id,
      organizationId: row.organization_id,
      brandId: row.brand_id,
      reason: (JSON.parse(row.metadata) as { reason?: string }).reason,
    })),
  };
}

function resolution(tenant: Tenant, links: Links, action: "approve" | "reject", note: string) {
  return {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    userId: tenant.userId,
    reviewId: links.reviewId,
    action,
    reasonCode: "wrong_logo",
    note,
  };
}

async function approveCommitsEveryWrite(sql: Sql) {
  const tenant = await studioTenant(sql, "review-tx-approve");
  const links = await openReview(sql, tenant, "approve");
  await applyReviewDecision(sql, { ...resolution(tenant, links, "approve", "Matches the brand voice."), reasonCode: "other" });

  const after = await snapshot(sql, links);
  assert.equal(after.review, "approved", "the review is approved");
  assert.equal(after.decision?.reviewerId, tenant.userId, "the reviewer is recorded on the decision");
  assert.equal(after.decision?.reviewerDecision, "approve");
  assert.equal(after.decision?.reviewerNote, "Matches the brand voice.");
  assert.equal(after.decision?.reviewed, true, "the review time is recorded");
  assert.equal(after.creative, "approved", "the creative is approved");
  assert.deepEqual(after.rejections, [], "an approval writes no rejection row");
  assert.equal(after.opportunity, "open", "an approval leaves the opportunity open");
  assert.deepEqual(
    after.audits,
    [{ action: "review.approved", actorId: tenant.userId, organizationId: tenant.organizationId, brandId: tenant.brandId, reason: "other" }],
    "the audit row is written with the workspace and brand",
  );

  // The review is no longer open, so a second decision is refused and the first one stands.
  await assert.rejects(applyReviewDecision(sql, resolution(tenant, links, "reject", "Changed my mind.")), /That review is not open\./);
  assert.deepEqual(await snapshot(sql, links), after, "the refused second decision changed nothing");
}

async function rejectCommitsEveryWrite(sql: Sql) {
  const tenant = await studioTenant(sql, "review-tx-reject");
  const links = await openReview(sql, tenant, "reject");
  await applyReviewDecision(sql, resolution(tenant, links, "reject", "Logo is off-brand."));

  const after = await snapshot(sql, links);
  assert.equal(after.review, "rejected", "the review is rejected");
  assert.equal(after.decision?.reviewerId, tenant.userId);
  assert.equal(after.decision?.reviewerDecision, "reject");
  assert.equal(after.decision?.reviewerNote, "Logo is off-brand.");
  assert.equal(after.decision?.reviewed, true);
  assert.equal(after.creative, "rejected", "the creative is rejected");
  assert.deepEqual(
    after.rejections,
    [{ reasonCode: "wrong_logo", note: "Logo is off-brand.", rejectedBy: tenant.userId, creativeId: links.creativeId, decisionId: links.decisionId }],
    "the rejection row names the creative, the decision and the reason",
  );
  assert.equal(after.opportunity, "dismissed", "the rejection dismisses the opportunity");
  assert.deepEqual(
    after.audits,
    [{ action: "review.rejected", actorId: tenant.userId, organizationId: tenant.organizationId, brandId: tenant.brandId, reason: "wrong_logo" }],
    "the audit row is written with the workspace and brand",
  );
}

/** Each write the action makes, failed in turn. The audit insert is the last write, so a failure there rolls back all the others. */
const INJECTIONS = [
  { step: "the review update", pattern: /update reviews set/ },
  { step: "the decision update", pattern: /update jev_decisions set/ },
  { step: "the creative update", pattern: /update creative_records set/ },
  { step: "the rejection insert", pattern: /insert into rejections/ },
  { step: "the opportunity update", pattern: /update opportunities set/ },
  { step: "the audit insert", pattern: /insert into audit_log/ },
];

async function failedWriteRollsBackEverything(sql: Sql, action: "approve" | "reject", pattern: RegExp) {
  const tenant = await studioTenant(sql, `review-tx-fail-${action}`);
  const links = await openReview(sql, tenant, `fail-${action}`);
  const before = await snapshot(sql, links);
  const input = resolution(tenant, links, action, "Rolled back.");

  await assert.rejects(applyReviewDecision(failingSql(sql, pattern), input), /injected write failure/);
  assert.deepEqual(await snapshot(sql, links), before, "the review, decision, creative, rejection, opportunity and audit are all unchanged");

  // The rollback leaves nothing that blocks the next attempt: the same action now succeeds.
  await applyReviewDecision(sql, input);
  assert.equal((await snapshot(sql, links)).review, action === "approve" ? "approved" : "rejected");
}

/** Another workspace's review is refused, and nothing in it is touched. */
async function otherWorkspaceReviewIsRefused(sql: Sql) {
  const mine = await studioTenant(sql, "review-tx-mine");
  const theirs = await studioTenant(sql, "review-tx-theirs");
  const foreign = await openReview(sql, theirs, "foreign");
  const before = await snapshot(sql, foreign);

  // The brand gate the handler runs first refuses a caller who is not a member of the brand's workspace.
  await assert.rejects(requireBrand(sql, mine.userId, theirs.brandId, "member"), /not available to you/);
  // Even when the caller's own workspace and brand are passed, the review is not found there, so nothing is written.
  await assert.rejects(
    applyReviewDecision(sql, resolution(mine, foreign, "reject", "Not mine.")),
    /That review is not open\./,
  );
  assert.deepEqual(await snapshot(sql, foreign), before, "the other workspace's review, decision, creative and opportunity are untouched");
}

/** A review in the caller's brand that points at another workspace's creative or opportunity is refused, and rolls back. */
async function foreignLinkIsRefusedAndRolledBack(sql: Sql) {
  const mine = await studioTenant(sql, "review-tx-link-mine");
  const theirs = await studioTenant(sql, "review-tx-link-theirs");
  const suffix = suffixFor("link");

  const creativeLink = await openReview(sql, mine, "creative-link");
  const foreignCreative = await insertCreative(sql, theirs, suffix);
  await sql`update reviews set creative_id = ${foreignCreative} where id = ${creativeLink.reviewId}`;
  const creativeSnapshot = { ...creativeLink, creativeId: foreignCreative };
  const creativeBefore = await snapshot(sql, creativeSnapshot);
  await assert.rejects(
    applyReviewDecision(sql, resolution(mine, creativeLink, "reject", "Foreign creative.")),
    /not in this brand/,
  );
  assert.deepEqual(await snapshot(sql, creativeSnapshot), creativeBefore, "nothing changed when the creative belongs to another workspace");

  const opportunityLink = await openReview(sql, mine, "opportunity-link");
  const foreignOpportunity = await insertOpportunity(sql, theirs, suffix);
  await sql`update reviews set opportunity_id = ${foreignOpportunity} where id = ${opportunityLink.reviewId}`;
  const opportunitySnapshot = { ...opportunityLink, opportunityId: foreignOpportunity };
  const opportunityBefore = await snapshot(sql, opportunitySnapshot);
  await assert.rejects(
    applyReviewDecision(sql, resolution(mine, opportunityLink, "reject", "Foreign opportunity.")),
    /not in this brand/,
  );
  assert.deepEqual(await snapshot(sql, opportunitySnapshot), opportunityBefore, "nothing changed when the opportunity belongs to another workspace");
}

for (const target of TARGETS) {
  test(`approve commits every write together on the ${target}`, async (t) => {
    await onTarget(target, t, approveCommitsEveryWrite);
  });

  test(`reject commits every write together on the ${target}`, async (t) => {
    await onTarget(target, t, rejectCommitsEveryWrite);
  });

  test(`approve: a failure at the audit insert rolls back every earlier write on the ${target}`, async (t) => {
    await onTarget(target, t, (sql) => failedWriteRollsBackEverything(sql, "approve", /insert into audit_log/));
  });

  for (const injection of INJECTIONS) {
    test(`reject: a failure at ${injection.step} rolls back every earlier write on the ${target}`, async (t) => {
      await onTarget(target, t, (sql) => failedWriteRollsBackEverything(sql, "reject", injection.pattern));
    });
  }

  test(`another workspace's review is refused and untouched on the ${target}`, async (t) => {
    await onTarget(target, t, otherWorkspaceReviewIsRefused);
  });

  test(`a foreign creative or opportunity link is refused and rolled back on the ${target}`, async (t) => {
    await onTarget(target, t, foreignLinkIsRefusedAndRolledBack);
  });
}
