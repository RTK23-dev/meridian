import assert from "node:assert/strict";
import test from "node:test";
import { createPoolSql, getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { failingSql } from "../testing/opportunity-fixtures.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { BRAND_QUESTION, BRIEF, approvesBrief, createBrief, registryWith, stubEngine } from "../testing/brief-fixtures.ts";
import { BRIEF_REVIEW_MINIMUM_ROLE, loadBriefReviewDisclosure, reviewBrief, briefStatusFor, productionRefusalFor } from "./brief-review.server.ts";
import { loadGatedJevDecision } from "./session.server.ts";

const REASON = "Reviewed the disclosed failure. The brand fit is clear from the positioning and the copy.";

async function blocked(sql: Awaited<ReturnType<typeof getSql>>, decisionId: string) {
  const [row] = await sql<{ decision: string; reviewer_decision: string | null; subject_id: string; organization_id: string; brand_id: string; id: string }>`
    select * from jev_decisions where id = ${decisionId}
  `;
  return loadGatedJevDecision(sql, row!.organization_id, row!.brand_id, row!.id, "brief").then(
    () => false,
    () => true,
  );
}

test("an engine error holds the brief for review: creation does not approve it, and production refuses it", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "review-engine-error");
  const jev = stubEngine("jev");
  const openai = stubEngine("openai-decisions", { failure: true });
  const made = await createBrief(sql, tenant, { engines: registryWith(jev, openai), selected: { engineId: "openai-decisions", source: "workspace" } });
  assert.equal(made.action, "HUMAN_REVIEW");
  const [brief] = await sql<{ status: string }>`select status from briefs where id = ${made.briefId}`;
  assert.equal(brief?.status, "awaiting_review", "the brief waits for review");
  const [row] = await sql<{ reviewer_decision: string | null; reviewer_id: string | null }>`
    select reviewer_decision, reviewer_id from jev_decisions where id = ${made.decisionId}
  `;
  assert.equal(row?.reviewer_decision, null, "creation records no approval");
  assert.equal(row?.reviewer_id, null);
  assert.equal(await blocked(sql, made.decisionId), true, "production refuses an unreviewed brief");
  assert.equal(jev.requests.length, 0, "no silent switch to the other engine");
});

test("an unsupported or unresolved judgment holds the brief too, and the disclosure names the unresolved questions", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "review-unresolved");
  // The engine answers only the brand question. The other two required questions are unresolved.
  const jev = stubEngine("jev", { respond: (spec) => (spec.id === BRAND_QUESTION ? approvesBrief(spec) : undefined) });
  const made = await createBrief(sql, tenant, { engines: registryWith(jev, stubEngine("openai-decisions")), selected: { engineId: "jev", source: "workspace" } });
  assert.equal(made.action, "HUMAN_REVIEW");
  const disclosure = await loadBriefReviewDisclosure(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, briefId: made.briefId });
  assert.equal(disclosure.reviewable, true);
  assert.equal(disclosure.unresolved.length, 2, "both unanswered questions are disclosed");
  assert.ok(disclosure.unresolved.every((item) => item.status === "missing"));
  assert.ok(disclosure.evidence.some((item) => item.name === "brief_fields"), "the evidence provided is disclosed");
  assert.equal(await blocked(sql, made.decisionId), true);
});

test("an explicit approval releases the brief, and the review keeps the original engine outcome", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "review-approve");
  const openai = stubEngine("openai-decisions", { failure: true });
  const made = await createBrief(sql, tenant, { engines: registryWith(stubEngine("jev"), openai), selected: { engineId: "openai-decisions", source: "workspace" } });
  const reviewed = await reviewBrief(sql, {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    briefId: made.briefId,
    reviewerId: "reviewer-1",
    reviewerRole: "admin",
    action: "approve",
    reason: REASON,
    acknowledged: true,
  });
  assert.equal(reviewed.briefStatus, "ready");
  assert.equal(await blocked(sql, made.decisionId), false, "production may proceed after the explicit review");

  const [review] = await sql<{ action: string; original_action: string; original_outcome: unknown; reviewer_is_creator: boolean; reason: string }>`
    select action, original_action, original_outcome, reviewer_is_creator, reason from decision_reviews where id = ${reviewed.reviewId}
  `;
  assert.equal(review?.action, "approve");
  assert.equal(review?.original_action, "HUMAN_REVIEW", "the original outcome is kept");
  assert.match(JSON.stringify(review?.original_outcome), /"failureKind":"provider_unavailable"/, "the failure is kept");
  assert.equal(review?.reviewer_is_creator, false);
  assert.equal(review?.reason, REASON);
  const [audit] = await sql<{ metadata: string }>`
    select metadata from audit_log where organization_id = ${tenant.organizationId} and action = 'brief.review'
  `;
  assert.match(audit?.metadata ?? "", /HUMAN_REVIEW/, "the audit record names the original outcome");
});

test("a rejection keeps the brief blocked", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "review-reject");
  const made = await createBrief(sql, tenant, { engines: registryWith(stubEngine("jev"), stubEngine("openai-decisions", { failure: true })), selected: { engineId: "openai-decisions", source: "workspace" } });
  const reviewed = await reviewBrief(sql, {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    briefId: made.briefId,
    reviewerId: "reviewer-2",
    reviewerRole: "owner",
    action: "reject",
    reason: "The disclosed failure leaves the claim unchecked; this brief will not be used.",
    acknowledged: true,
  });
  assert.equal(reviewed.briefStatus, "rejected");
  assert.equal(await blocked(sql, made.decisionId), true);
});

test("a member or viewer cannot review, and the minimum role is stated", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "review-role");
  const made = await createBrief(sql, tenant, { engines: registryWith(stubEngine("jev"), stubEngine("openai-decisions", { failure: true })), selected: { engineId: "openai-decisions", source: "workspace" } });
  assert.equal(BRIEF_REVIEW_MINIMUM_ROLE, "admin");
  for (const role of ["viewer", "member"]) {
    await assert.rejects(
      reviewBrief(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, briefId: made.briefId, reviewerId: "x", reviewerRole: role, action: "approve", reason: REASON, acknowledged: true }),
      /Only an admin or owner/,
    );
  }
  assert.equal(await blocked(sql, made.decisionId), true, "a refused review releases nothing");
});

test("a review needs the acknowledgement and a written reason", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "review-inputs");
  const made = await createBrief(sql, tenant, { engines: registryWith(stubEngine("jev"), stubEngine("openai-decisions", { failure: true })), selected: { engineId: "openai-decisions", source: "workspace" } });
  const base = { organizationId: tenant.organizationId, brandId: tenant.brandId, briefId: made.briefId, reviewerId: "reviewer-3", reviewerRole: "admin", action: "approve" as const };
  await assert.rejects(reviewBrief(sql, { ...base, reason: REASON, acknowledged: false }), /Confirm that you have read/);
  await assert.rejects(reviewBrief(sql, { ...base, reason: "ok", acknowledged: true }), /at least 20 characters/);
  assert.equal(await blocked(sql, made.decisionId), true);
});

test("a deterministic or engine rejection cannot be reviewed into approval", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "review-rejected-brief");
  const made = await createBrief(sql, tenant, {
    engines: registryWith(stubEngine("jev", { respond: approvesBrief }), stubEngine("openai-decisions")),
    selected: { engineId: "jev", source: "workspace" },
    brief: { ...BRIEF, hook: "" },
  });
  assert.equal(made.action, "REJECT");
  await assert.rejects(
    reviewBrief(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, briefId: made.briefId, reviewerId: "owner-1", reviewerRole: "owner", action: "approve", reason: REASON, acknowledged: true }),
    /not awaiting review/,
  );
  assert.equal(await blocked(sql, made.decisionId), true, "the mandatory-field rejection is final");
});

test("a second review of the same brief is refused, and the first decision stands", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "review-twice");
  const made = await createBrief(sql, tenant, { engines: registryWith(stubEngine("jev"), stubEngine("openai-decisions", { failure: true })), selected: { engineId: "openai-decisions", source: "workspace" } });
  const first = { organizationId: tenant.organizationId, brandId: tenant.brandId, briefId: made.briefId, reviewerId: "reviewer-4", reviewerRole: "admin", reason: REASON, acknowledged: true };
  await reviewBrief(sql, { ...first, action: "reject" });
  await assert.rejects(reviewBrief(sql, { ...first, action: "approve" }), /not awaiting review/);
  const [row] = await sql<{ reviewer_decision: string }>`select reviewer_decision from jev_decisions where id = ${made.decisionId}`;
  assert.equal(row?.reviewer_decision, "reject", "the first review stands");
});

test("the creator may review their own brief, and the record says so", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "review-creator");
  const made = await createBrief(sql, tenant, { engines: registryWith(stubEngine("jev"), stubEngine("openai-decisions", { failure: true })), selected: { engineId: "openai-decisions", source: "workspace" }, creatorId: "creator-1" });
  const reviewed = await reviewBrief(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, briefId: made.briefId, reviewerId: "creator-1", reviewerRole: "admin", action: "approve", reason: REASON, acknowledged: true });
  const [review] = await sql<{ reviewer_is_creator: boolean }>`select reviewer_is_creator from decision_reviews where id = ${reviewed.reviewId}`;
  assert.equal(review?.reviewer_is_creator, true, "allowed, and recorded as a self-review");
});

test("the review record is append-only", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "review-append-only");
  const made = await createBrief(sql, tenant, { engines: registryWith(stubEngine("jev"), stubEngine("openai-decisions", { failure: true })), selected: { engineId: "openai-decisions", source: "workspace" } });
  const reviewed = await reviewBrief(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, briefId: made.briefId, reviewerId: "reviewer-5", reviewerRole: "admin", action: "approve", reason: REASON, acknowledged: true });
  await assert.rejects(sql`update decision_reviews set reason = 'changed' where id = ${reviewed.reviewId}`, /append-only/);
  await assert.rejects(sql`delete from decision_reviews where id = ${reviewed.reviewId}`, /append-only/);
});

test("production refuses every brief that is not ready or used, whichever path created it", () => {
  assert.equal(productionRefusalFor("ready"), null);
  assert.equal(productionRefusalFor("used"), null);
  assert.match(productionRefusalFor("awaiting_review") ?? "", /awaiting review/);
  assert.match(productionRefusalFor("rejected") ?? "", /did not pass the gate/);
  assert.match(productionRefusalFor("draft") ?? "", /not ready for production/, "an unknown status is refused, not allowed");
});

test("a held brief whose engine record is missing cannot be reviewed, so an empty disclosure is never acknowledged", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "review-missing-record");
  const openai = stubEngine("openai-decisions", { failure: true });
  const made = await createBrief(sql, tenant, { engines: registryWith(stubEngine("jev"), openai), selected: { engineId: "openai-decisions", source: "workspace" } });
  // The record link is lost, as it would be if the gate record insert had failed.
  await sql`update jev_decisions set evidence = '{}'::jsonb where id = ${made.decisionId}`;
  const disclosure = await loadBriefReviewDisclosure(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, briefId: made.briefId });
  assert.equal(disclosure.reviewable, false);
  await assert.rejects(
    reviewBrief(sql, {
      organizationId: tenant.organizationId,
      brandId: tenant.brandId,
      briefId: made.briefId,
      reviewerId: "reviewer-1",
      reviewerRole: "admin",
      action: "approve",
      acknowledged: true,
      reason: REASON,
    }),
    /engine's record for this brief is missing/,
  );
  const [brief] = await sql<{ status: string }>`select status from briefs where id = ${made.briefId}`;
  assert.equal(brief?.status, "awaiting_review", "the brief stays held");
});

test("the status a gate outcome gives a brief: only an automatic approval is ready without a person", () => {
  assert.equal(briefStatusFor("AUTO_APPROVE"), "ready");
  assert.equal(briefStatusFor("HUMAN_REVIEW"), "awaiting_review");
  assert.equal(briefStatusFor("REJECT"), "rejected");
});

test("the real planning entry point refuses a held brief, and stops refusing it only after an explicit review", async () => {
  const { generateStudioVariants } = await import("./session.server.ts");
  const sql = await getSql();
  const tenant = await studioTenant(sql, "review-planning-gate");
  const made = await createBrief(sql, tenant, { engines: registryWith(stubEngine("jev"), stubEngine("openai-decisions", { failure: true })), selected: { engineId: "openai-decisions", source: "workspace" } });
  const request = { brandId: tenant.brandId, briefId: made.briefId, imageProvider: "none", videoProvider: "none", creationScope: "research_only", autonomy: "manual", maxSpendUsd: 1, mode: "research_only", source: "new_brief", aspectRatio: "1:1" } as unknown as Parameters<typeof generateStudioVariants>[1];
  await assert.rejects(generateStudioVariants(tenant.userId, request), /human review/i, "a held brief cannot be planned");
  await reviewBrief(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, briefId: made.briefId, reviewerId: tenant.userId, reviewerRole: "admin", action: "approve", reason: REASON, acknowledged: true });
  const after = await generateStudioVariants(tenant.userId, request).then(() => null, (error: unknown) => (error instanceof Error ? error.message : String(error)));
  assert.ok(!(after !== null && /human review|JEV/i.test(after)), `after review, planning is no longer refused by the review gate (${after ?? "accepted"})`);
});

/**
 * Atomicity of the review. A failing write is injected at each of the three writes that follow the claim. The brief must still
 * be awaiting review, the decision unreviewed, and no review row or audit row left behind. The same check runs on PGlite and,
 * when MERIDIAN_PG_TEST_URL is set, on PostgreSQL through a pinned pool connection.
 */
const PG_TEST_URL = process.env.MERIDIAN_PG_TEST_URL?.trim();
const INJECTIONS = [
  { step: "the audit insert", pattern: /insert into audit_log/ },
  { step: "the decision_reviews insert", pattern: /insert into decision_reviews/ },
  { step: "the brief move", pattern: /update briefs set status/ },
];

async function injectedReviewLeavesNothing(sql: Sql, pattern: RegExp) {
  const tenant = await studioTenant(sql, `review-atomic-${Math.random().toString(36).slice(2, 8)}`);
  const made = await createBrief(sql, tenant, {
    engines: registryWith(stubEngine("jev"), stubEngine("openai-decisions", { failure: true })),
    selected: { engineId: "openai-decisions", source: "workspace" },
  });
  assert.equal(made.action, "HUMAN_REVIEW");
  const review = {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    briefId: made.briefId,
    reviewerId: "reviewer-atomic",
    reviewerRole: "admin",
    action: "approve" as const,
    reason: REASON,
    acknowledged: true,
  };
  await assert.rejects(reviewBrief(failingSql(sql, pattern), review), /injected write failure/);

  const [brief] = await sql<{ status: string }>`select status from briefs where id = ${made.briefId}`;
  assert.equal(brief?.status, "awaiting_review", "the brief is still awaiting review");
  const [decision] = await sql<{ reviewer_decision: string | null; reviewer_id: string | null }>`
    select reviewer_decision, reviewer_id from jev_decisions where id = ${made.decisionId}
  `;
  assert.equal(decision?.reviewer_decision, null, "the decision is still unreviewed");
  assert.equal(decision?.reviewer_id, null, "no reviewer is recorded on the decision");
  const [reviews] = await sql<{ count: number }>`select count(*)::int as count from decision_reviews where decision_id = ${made.decisionId}`;
  assert.equal(reviews?.count, 0, "no decision_reviews row exists");
  const [audits] = await sql<{ count: number }>`
    select count(*)::int as count from audit_log where object_id = ${made.briefId} and action = 'brief.review'
  `;
  assert.equal(audits?.count, 0, "no audit row was left behind");

  // The rollback leaves nothing that blocks the next attempt: the same review now succeeds.
  const reviewed = await reviewBrief(sql, review);
  assert.equal(reviewed.briefStatus, "ready");
  const [after] = await sql<{ status: string }>`select status from briefs where id = ${made.briefId}`;
  assert.equal(after?.status, "ready");
}

for (const injection of INJECTIONS) {
  test(`review is atomic on PGlite: a failure at ${injection.step} leaves the brief awaiting review and the decision unreviewed`, async () => {
    await injectedReviewLeavesNothing(await getSql(), injection.pattern);
  });

  test(`review is atomic on PostgreSQL: a failure at ${injection.step} leaves the brief awaiting review and the decision unreviewed`, async (t) => {
    if (!PG_TEST_URL) {
      t.skip("MERIDIAN_PG_TEST_URL is not set, so the PostgreSQL atomicity check was not run");
      return;
    }
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: PG_TEST_URL });
    try {
      await injectedReviewLeavesNothing(createPoolSql(pool), injection.pattern);
    } finally {
      await pool.end();
    }
  });
}
