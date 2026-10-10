import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getSql } from "../../db.ts";
import type { Sql } from "../learning/store.ts";
import { studioTenant } from "../testing/durable-image-fixtures.ts";
import { BRAIN, BRIEF, registryWith, stubEngine } from "../testing/brief-fixtures.ts";
import { judgeBriefFit, type BriefBrain, type BriefForGate } from "./brief-gate.server.ts";
import type { BriefRecord } from "./brief-service.contract.ts";
import { createGatedBrief } from "./brief-service.server.ts";
import { reviewBriefForUser } from "./brief-review-access.server.ts";
import { loadBriefReviewDisclosure, productionRefusalFor } from "./brief-review.server.ts";
import { loadGatedJevDecision } from "./session.server.ts";
import type { EngineSelection } from "../decisions/selection.ts";
import type { DecisionEngineRegistry } from "../decisions/dispatcher.ts";

const REASON = "Reviewed the disclosed failure. The brand fit is clear from the positioning and the copy.";

/** The brief row fields an opportunity's brief carries, shaped as buildBrief shapes them. */
function recordOf(brief: BriefForGate, opportunityId: string): BriefRecord {
  return {
    opportunityId,
    title: `Opportunity: ${brief.angle}`,
    audience: brief.audience,
    angle: brief.angle,
    hook: brief.hook,
    message: brief.message,
    offer: brief.offer ?? "",
    cta: brief.cta,
    format: brief.format,
    proofType: "demonstration",
    constraints: "",
    context: {
      brandPositioning: BRAIN.positioning,
      prohibitedClaims: BRAIN.prohibitedClaims,
      wordsToAvoid: "",
      requiredDisclaimers: "",
      patterns: [],
      failures: [],
      opportunityReason: "",
      untrustedObservations: [],
    },
    workflow: { templateId: "", templateVersion: "", label: "", stages: [], variables: { product: "Meal planner" } },
    why: ["The opportunity is the direction this brief tests."],
    learningNotes: [],
    failureNotes: [],
  };
}

/** The opportunity path's call: the same judge callback the creative action passes to createGatedBrief. */
function createOpportunityBrief(
  sql: Sql,
  tenant: { organizationId: string; brandId: string; userId: string },
  opportunityId: string,
  brief: BriefForGate,
  options: { engines: DecisionEngineRegistry; selection: EngineSelection; brain?: BriefBrain },
) {
  return createGatedBrief(sql, {
    organizationId: tenant.organizationId,
    brandId: tenant.brandId,
    createdBy: tenant.userId,
    brief: recordOf(brief, opportunityId),
    judge: (briefId) => judgeBriefFit({
      sql,
      organizationId: tenant.organizationId,
      brandId: tenant.brandId,
      briefId,
      brief,
      brain: options.brain ?? BRAIN,
      engines: options.engines,
      selection: options.selection,
    }),
  });
}

async function insertOpportunity(sql: Sql, tenant: { organizationId: string; brandId: string }) {
  const opportunityId = `opp-${randomUUID()}`;
  await sql`
    insert into opportunities (
      id, organization_id, brand_id, hypothesis_id, label, category, angle, hook_type, audience, format, proof_type,
      product_name, market_signal, novelty_score, brand_fit_score, reproducibility_score, risk_score, saturation_score,
      historical_score, expected_value, raw_score, confidence, reason, evidence, evidence_basis, supporting_ids, status
    ) values (
      ${opportunityId}, ${tenant.organizationId}, ${tenant.brandId}, 'discovered:dinner-in-ten', 'Dinner in ten minutes',
      'meal planning', 'dinner in ten minutes', 'problem', 'Busy parents', 'video', 'demonstration', 'Meal planner',
      0.6, 0.5, 0.8, 0.5, 0.1, 0.2, 0.5, 0.4, 0.4, 0.6, 'Fixture opportunity', '[]', 'fixture', '[]', 'open'
    )
  `;
  return opportunityId;
}

/** A real membership row in the tenant's workspace, so the access check reads the role from the database. */
async function addMember(sql: Sql, tenant: { organizationId: string }, role: "admin" | "member") {
  const userId = `user-${role}-${randomUUID()}`;
  await sql`insert into "user" (id, name, email, "emailVerified") values (${userId}, ${`Fixture ${role}`}, ${`${userId}@fixture.example`}, true)`;
  await sql`
    insert into memberships (id, organization_id, user_id, role)
    values (${`mem-${userId}`}, ${tenant.organizationId}, ${userId}, ${role})
  `;
  return userId;
}

test("an opportunity brief the engine could not judge is held: a member's review is refused, and an admin's review releases it", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "opportunity-brief-review");
  const admin = await addMember(sql, tenant, "admin");
  const opportunityId = await insertOpportunity(sql, tenant);
  const jev = stubEngine("jev");
  const openai = stubEngine("openai-decisions", { failure: true });
  const made = await createOpportunityBrief(sql, tenant, opportunityId, BRIEF, {
    engines: registryWith(jev, openai),
    selection: { engineId: "openai-decisions", source: "workspace" },
  });
  assert.equal(made.action, "HUMAN_REVIEW");
  assert.equal(made.status, "awaiting_review");
  assert.equal(jev.requests.length, 0, "no silent switch to the other engine");

  const [held] = await sql<{ status: string; opportunity_id: string; decision_id: string }>`
    select status, opportunity_id, decision_id from briefs where id = ${made.briefId}
  `;
  assert.equal(held?.status, "awaiting_review", "the brief waits for review");
  assert.equal(held?.opportunity_id, opportunityId, "the brief is the opportunity's brief");
  const [opportunity] = await sql<{ status: string }>`select status from opportunities where id = ${opportunityId}`;
  assert.equal(opportunity?.status, "briefed", "the opportunity is briefed, as the gate-approved path leaves it");

  const disclosure = await loadBriefReviewDisclosure(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, briefId: made.briefId });
  assert.equal(disclosure.reviewable, true);
  assert.notEqual(disclosure.gateRecordId, null, "the held brief links to its engine record, so a reviewer can read the failure");
  assert.equal(disclosure.failureKind, "provider_unavailable");
  await assert.rejects(
    loadGatedJevDecision(sql, tenant.organizationId, tenant.brandId, held!.decision_id, "brief"),
    /human review/i,
    "production refuses the held brief",
  );

  await assert.rejects(
    reviewBriefForUser(sql, tenant.userId, { brandId: tenant.brandId, briefId: made.briefId, action: "approve", reason: REASON, acknowledged: true }),
    /do not have permission/,
    "a member cannot review",
  );
  const [afterMember] = await sql<{ status: string }>`select status from briefs where id = ${made.briefId}`;
  assert.equal(afterMember?.status, "awaiting_review", "a refused review releases nothing");

  const reviewed = await reviewBriefForUser(sql, admin, { brandId: tenant.brandId, briefId: made.briefId, action: "approve", reason: REASON, acknowledged: true });
  assert.equal(reviewed.briefStatus, "ready");
  assert.equal(productionRefusalFor("ready"), null, "a released brief is not refused by production");
  await loadGatedJevDecision(sql, tenant.organizationId, tenant.brandId, held!.decision_id, "brief");

  const [review] = await sql<{ reviewer_role: string; original_action: string }>`
    select reviewer_role, original_action from decision_reviews where id = ${reviewed.reviewId}
  `;
  assert.equal(review?.reviewer_role, "admin");
  assert.equal(review?.original_action, "HUMAN_REVIEW", "the review keeps the original engine outcome");
});

test("an opportunity brief that breaks a stored prohibited claim is rejected before any engine is asked, and cannot be reviewed into approval", async () => {
  const sql = await getSql();
  const tenant = await studioTenant(sql, "opportunity-brief-prohibited");
  const admin = await addMember(sql, tenant, "admin");
  const opportunityId = await insertOpportunity(sql, tenant);
  const jev = stubEngine("jev");
  const made = await createOpportunityBrief(sql, tenant, opportunityId, { ...BRIEF, message: "A guaranteed calm dinner in ten minutes" }, {
    engines: registryWith(jev, stubEngine("openai-decisions")),
    selection: { engineId: "jev", source: "workspace" },
  });
  assert.equal(made.action, "REJECT");
  assert.equal(made.status, "rejected");
  assert.equal(jev.requests.length, 0, "a deterministic rejection never reaches an engine");

  const [rejected] = await sql<{ status: string }>`select status from briefs where id = ${made.briefId}`;
  assert.equal(rejected?.status, "rejected");
  const [opportunity] = await sql<{ status: string }>`select status from opportunities where id = ${opportunityId}`;
  assert.equal(opportunity?.status, "open", "a rejected brief does not brief the opportunity");

  const disclosure = await loadBriefReviewDisclosure(sql, { organizationId: tenant.organizationId, brandId: tenant.brandId, briefId: made.briefId });
  assert.equal(disclosure.reviewable, false);
  assert.notEqual(disclosure.gateRecordId, null, "the rejection is recorded with its gate record");
  await assert.rejects(
    reviewBriefForUser(sql, admin, { brandId: tenant.brandId, briefId: made.briefId, action: "approve", reason: REASON, acknowledged: true }),
    /not awaiting review/,
    "not even an admin can review a rejection into approval",
  );
});
