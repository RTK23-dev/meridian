/**
 * Explicit human review of a brief that the decision engine could not judge.
 *
 * A brief is HUMAN_REVIEW when the engine returned an error, an unsupported result, a malformed answer, or an unresolved
 * judgment for a required question. Such a brief waits in `awaiting_review`, and planning and production refuse it. Only
 * this review action can release it: it is a separate request from brief creation, it requires the reviewer to confirm
 * they have read the disclosed failure, and it requires a written reason. Creation, saving, and the original submit never
 * approve an engine failure.
 *
 * A REJECT cannot be reviewed into approval. That includes every deterministic rejection, which the engine cannot override.
 * The reviewer may be the brief's creator. That is recorded, not forbidden: with no independent reviewer available, the
 * override is made auditable instead.
 */
import { randomUUID } from "node:crypto";
import { withTransaction, type Sql } from "../learning/store.ts";
import { hasRole, isRole, type Role } from "../access.ts";
import type { PolicyOutcome } from "../decisions/policy.ts";

/** A review can release a brief the engine could not judge, so it needs a role that can change production. */
export const BRIEF_REVIEW_MINIMUM_ROLE: Role = "admin";
export const MIN_REVIEW_REASON_LENGTH = 20;

export type BriefStatus = "ready" | "awaiting_review" | "rejected";

/** The status a brief takes from its gate outcome. Only an automatic approval is ready without a person. */
export function briefStatusFor(action: PolicyOutcome): BriefStatus {
  if (action === "AUTO_APPROVE") return "ready";
  if (action === "HUMAN_REVIEW") return "awaiting_review";
  return "rejected";
}

/**
 * Why a brief cannot be made into a creative, or null when it can. A brief awaiting review or rejected never reaches
 * production, whichever path created it. Only a ready or used brief is allowed.
 */
export function productionRefusalFor(status: string): string | null {
  if (status === "ready" || status === "used") return null;
  if (status === "awaiting_review") {
    return "This brief is awaiting review. An admin or owner must review it before a creative is made from it.";
  }
  if (status === "rejected") return "This brief did not pass the gate.";
  return "This brief is not ready for production.";
}

export type BriefReviewDisclosure = {
  briefId: string;
  briefStatus: string;
  decisionId: string;
  decision: PolicyOutcome;
  engineId: string | null;
  requestedModel: string | null;
  returnedModel: string | null;
  gateRecordId: string | null;
  failureKind: string | null;
  reasons: string[];
  /** Questions the engine did not answer, with the reason for each. These are the questions the reviewer must weigh. */
  unresolved: Array<{ questionId: string; status: string; reason: string }>;
  votes: Array<{ questionId: string; outcome: string; reason: string }>;
  /** The evidence that was provided to the judgment, by name, with its real timestamp and hash where there is one. */
  evidence: Array<{ kind: string; name: string; timestampMs?: number; sha256?: string }>;
  policyVersion: string | null;
  questionVersions: string[];
  /** True only for a HUMAN_REVIEW brief that is awaiting review and has no review recorded yet. */
  reviewable: boolean;
  reviews: Array<{ action: string; reviewerRole: string; reviewerIsCreator: boolean; reason: string; createdAt: string }>;
};

function jsonOf<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

/** Loads what a reviewer must see before they decide: the failure, the unresolved questions, and the evidence. */
export async function loadBriefReviewDisclosure(
  sql: Sql,
  input: { organizationId: string; brandId: string; briefId: string },
): Promise<BriefReviewDisclosure> {
  const [brief] = await sql<{ id: string; status: string; decision_id: string | null }>`
    select id, status, decision_id from briefs
    where id = ${input.briefId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
    limit 1
  `;
  if (!brief || !brief.decision_id) throw new Error("The brief was not found in this brand.");
  const [row] = await sql<{
    id: string; decision: string; reviewer_decision: string | null; reasons: string; evidence: string; provider: string; model: string;
  }>`
    select id, decision, reviewer_decision, reasons, evidence, provider, model from jev_decisions
    where id = ${brief.decision_id} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
    limit 1
  `;
  if (!row) throw new Error("The brief's decision was not found in this brand.");

  const evidenceRef = jsonOf<{ gateRecordId?: string }>(row.evidence, {});
  const gateRecordId = evidenceRef.gateRecordId ?? null;
  const [record] = gateRecordId
    ? await sql<{
        engine_id: string | null; requested_model: string | null; returned_model: string | null; failure_kind: string | null;
        votes: unknown; unresolved: unknown; evidence: unknown; policy_version: string; question_versions: unknown; action: string;
      }>`
        select engine_id, requested_model, returned_model, failure_kind, votes, unresolved, evidence, policy_version,
               question_versions, action
        from decision_gate_records
        where id = ${gateRecordId} and organization_id = ${input.organizationId}
        limit 1
      `
    : [];
  const reviews = await sql<{ action: string; reviewer_role: string; reviewer_is_creator: boolean; reason: string; created_at: unknown }>`
    select action, reviewer_role, reviewer_is_creator, reason, created_at from decision_reviews
    where decision_id = ${row.id} and organization_id = ${input.organizationId}
    order by created_at asc
  `;

  const decision = (row.decision.toUpperCase() as PolicyOutcome);
  const unreviewed = row.reviewer_decision === null || row.reviewer_decision === undefined;
  return {
    briefId: brief.id,
    briefStatus: brief.status,
    decisionId: row.id,
    decision,
    engineId: record?.engine_id ?? null,
    requestedModel: record?.requested_model ?? null,
    returnedModel: record?.returned_model ?? row.model ?? null,
    gateRecordId,
    failureKind: record?.failure_kind ?? null,
    reasons: jsonOf<string[]>(row.reasons, []),
    unresolved: jsonOf<BriefReviewDisclosure["unresolved"]>(record?.unresolved, []),
    votes: jsonOf<BriefReviewDisclosure["votes"]>(record?.votes, []),
    evidence: jsonOf<Array<{ kind: string; name: string; timestampMs?: number; sha256?: string }>>(record?.evidence, []),
    policyVersion: record?.policy_version ?? null,
    questionVersions: jsonOf<string[]>(record?.question_versions, []),
    // A review needs the engine's recorded outcome. Without the record, the reviewer would acknowledge an empty disclosure,
    // so the brief stays held and cannot be released.
    reviewable: brief.status === "awaiting_review" && decision === "HUMAN_REVIEW" && unreviewed && record !== undefined,
    reviews: reviews.map((item) => ({
      action: item.action,
      reviewerRole: item.reviewer_role,
      reviewerIsCreator: item.reviewer_is_creator,
      reason: item.reason,
      createdAt: textOf(item.created_at),
    })),
  };
}

export type ReviewBriefInput = {
  organizationId: string;
  brandId: string;
  briefId: string;
  reviewerId: string;
  reviewerRole: string;
  action: "approve" | "reject";
  reason: string;
  /** The reviewer confirms they have read the disclosed failure and the unresolved questions. */
  acknowledged: boolean;
};

/**
 * Records one explicit review. The claim, the brief move, the append-only review and the audit record are one transaction,
 * so a failure at any step leaves the brief waiting and the decision unreviewed. A brief with no engine record is refused.
 */
export async function reviewBrief(sql: Sql, input: ReviewBriefInput): Promise<{ briefStatus: BriefStatus; reviewId: string }> {
  if (!isRole(input.reviewerRole) || !hasRole(input.reviewerRole, BRIEF_REVIEW_MINIMUM_ROLE)) {
    throw new Error("Only an admin or owner can review a brief the engine could not judge.");
  }
  if (input.action !== "approve" && input.action !== "reject") throw new Error("Choose approve or reject.");
  if (input.acknowledged !== true) {
    throw new Error("Confirm that you have read the failure and the unresolved questions before you review this brief.");
  }
  const reason = input.reason.trim();
  if (reason.length < MIN_REVIEW_REASON_LENGTH) {
    throw new Error(`Write the reason for this decision (at least ${MIN_REVIEW_REASON_LENGTH} characters).`);
  }

  const disclosure = await loadBriefReviewDisclosure(sql, input);
  if (disclosure.briefStatus === "awaiting_review" && disclosure.gateRecordId === null) {
    throw new Error("The engine's record for this brief is missing, so it cannot be reviewed. Create the brief again.");
  }
  if (!disclosure.reviewable) {
    throw new Error(`This brief is not awaiting review (status: ${disclosure.briefStatus}, decision: ${disclosure.decision}).`);
  }
  const [creator] = await sql<{ created_by: string }>`
    select created_by from briefs where id = ${input.briefId} and organization_id = ${input.organizationId}
  `;
  const reviewerIsCreator = creator?.created_by === input.reviewerId;
  const briefStatus: BriefStatus = input.action === "approve" ? "ready" : "rejected";
  const reviewId = randomUUID();

  // Every write below runs in one transaction. A failure at any step rolls back all of them, so the brief stays awaiting
  // review and the decision stays unreviewed. Nothing is reverted by hand, because a hand revert can fail too.
  await withTransaction(sql, async (tx) => {
    // 1. Claim the decision. Only a row with no review can be claimed, so two reviews cannot both succeed.
    const claimed = await tx<{ id: string }>`
      update jev_decisions
      set reviewer_id = ${input.reviewerId}, reviewer_decision = ${input.action === "approve" ? "approve" : "reject"},
          reviewed_at = now(), reviewer_note = ${reason}
      where id = ${disclosure.decisionId} and organization_id = ${input.organizationId} and reviewer_decision is null
      returning id
    `;
    if (claimed.length === 0) throw new Error("This brief was reviewed by someone else a moment ago.");

    // 2. Move the brief, only from awaiting review.
    const moved = await tx<{ id: string }>`
      update briefs set status = ${briefStatus}
      where id = ${input.briefId} and organization_id = ${input.organizationId} and status = 'awaiting_review'
      returning id
    `;
    if (moved.length === 0) throw new Error("The brief is no longer awaiting review.");

    // 3. The append-only review, with the original engine outcome exactly as the reviewer was shown it.
    await tx`
      insert into decision_reviews (
        id, organization_id, brand_id, decision_id, subject_type, subject_id, reviewer_id, reviewer_role,
        reviewer_is_creator, action, reason, original_action, original_outcome
      ) values (
        ${reviewId}, ${input.organizationId}, ${input.brandId}, ${disclosure.decisionId}, 'brief', ${input.briefId},
        ${input.reviewerId}, ${input.reviewerRole}, ${reviewerIsCreator}, ${input.action}, ${reason}, ${disclosure.decision},
        ${JSON.stringify({
          engineId: disclosure.engineId,
          requestedModel: disclosure.requestedModel,
          returnedModel: disclosure.returnedModel,
          gateRecordId: disclosure.gateRecordId,
          failureKind: disclosure.failureKind,
          reasons: disclosure.reasons,
          unresolved: disclosure.unresolved,
          evidence: disclosure.evidence,
          policyVersion: disclosure.policyVersion,
        })}
      )
    `;

    // 4. The audit record. It names the reviewer, the decision, and the original outcome. It carries no credential.
    await tx`
      insert into audit_log (id, organization_id, brand_id, actor_id, action, object_type, object_id, metadata)
      values (
        ${randomUUID()}, ${input.organizationId}, ${input.brandId}, ${input.reviewerId}, 'brief.review',
        'brief', ${input.briefId},
        ${JSON.stringify({ action: input.action, reviewId, originalAction: disclosure.decision, engineId: disclosure.engineId, failureKind: disclosure.failureKind, reviewerIsCreator })}
      )
    `;
  });
  return { briefStatus, reviewId };
}
