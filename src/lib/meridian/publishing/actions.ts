import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { mayAutoPublish, publishCreative } from "@/lib/meridian/providers/contracts";
import { withTransaction, type Sql } from "../learning/store.ts";
import { isReviewReasonCode, reviewReasonOptions } from "../reviews/reasons.ts";
import { loadReviewPage, reviewPage } from "../reviews/listing.ts";
import { engineInboxItems } from "../reviews/engine-items.ts";
import {
  id,
  asText,
  asNumber,
  asJson,
  storedAnswer,
  clip,
  objectInput,
  requireBrand,
  audit,
  notify,
} from "../machine-shared";

export { REVIEW_REASON_CODES } from "../reviews/reasons.ts";

export const listReviews = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    return { brandId: clip(body.brandId, 80, "Brand", true), ...reviewPage({ offset: body.offset, limit: body.limit }) };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "viewer");
    const page = await loadReviewPage(sql, access.organizationId, data.brandId, { offset: data.offset, limit: data.limit });
    return {
      role: access.role,
      reviews: page.rows.map((row) => ({
        id: asText(row.id),
        label: asText(row.subject_label),
        status: asText(row.status),
        creativeId: asText(row.creative_id),
        opportunityId: asText(row.opportunity_id),
        decision: asText(row.decision),
        probability: asNumber(row.probability),
        confidence: asNumber(row.confidence),
        question: `${asText(row.question_id)}.${asText(row.question_version)}`,
        reasons: asJson<string[]>(row.reasons, []),
        answer: storedAnswer(row.answer),
        policyVersion: asText(row.policy_version),
        createdAt: asText(row.created_at),
      })),
      // The video engine's open items for this brand. Read only: their decisions are the engine's, and Meridian does not change them here.
      engineItems: await engineInboxItems(sql, access.organizationId, data.brandId),
      // The window the list holds, and the totals over every review. hasMore says a further window has rows.
      offset: data.offset,
      limit: data.limit,
      total: page.total,
      openTotal: page.openTotal,
      decidedTotal: page.decidedTotal,
      hasMore: page.hasMore,
      reasonCodes: reviewReasonOptions(),
    };
  });

export const resolveReview = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = objectInput(input);
    const action = clip(body.action, 20, "Action", true);
    if (action !== "approve" && action !== "reject") throw new Error("Choose approve or reject.");
    const reasonCode = clip(body.reasonCode, 40, "Reason");
    if (action === "reject" && !isReviewReasonCode(reasonCode)) {
      throw new Error("Choose a rejection reason.");
    }
    return {
      brandId: clip(body.brandId, 80, "Brand", true),
      reviewId: clip(body.reviewId, 80, "Review", true),
      action,
      reasonCode: reasonCode || "other",
      note: clip(body.note, 500, "Note"),
    };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "member");
    await applyReviewDecision(sql, {
      organizationId: access.organizationId,
      brandId: data.brandId,
      userId: context.userId,
      reviewId: data.reviewId,
      action: data.action,
      reasonCode: data.reasonCode,
      note: data.note,
    });
    return { ok: true };
  });

/**
 * Records a reviewer's approve or reject of one open review. The review, its decision, the creative, the rejection row, the
 * opportunity and the audit row are written in one transaction, so they all change or none does. Every statement is scoped to
 * the caller's workspace and brand, and every UPDATE must match exactly one row: a row outside the brand rolls the whole
 * action back rather than leaving the decision, the creative and the audit trail out of step.
 */
export async function applyReviewDecision(
  sql: Sql,
  input: {
    organizationId: string;
    brandId: string;
    userId: string;
    reviewId: string;
    action: string;
    reasonCode: string;
    note: string;
  },
): Promise<void> {
  if (input.action !== "approve" && input.action !== "reject") throw new Error("Choose approve or reject.");
  const action = input.action === "approve" ? "approve" : "reject";
  const { organizationId, brandId } = input;
  await withTransaction(sql, async (tx) => {
    const rows = await tx<{ id: string; decision_id: string; creative_id: string | null; opportunity_id: string | null }>`
      select id, decision_id, creative_id, opportunity_id from reviews
      where id = ${input.reviewId} and brand_id = ${brandId} and organization_id = ${organizationId} and status = 'open'
      limit 1
    `;
    const review = rows[0];
    if (!review) throw new Error("That review is not open.");
    const nextStatus = action === "approve" ? "approved" : "rejected";
    expectOneRow(
      await tx`
        update reviews set status = ${nextStatus}
        where id = ${review.id} and brand_id = ${brandId} and organization_id = ${organizationId} and status = 'open'
        returning id
      `,
      "That review is not open.",
    );
    expectOneRow(
      await tx`
        update jev_decisions set
          reviewer_id = ${input.userId},
          reviewer_decision = ${action},
          reviewer_note = ${input.note},
          reviewed_at = now()
        where id = ${review.decision_id} and brand_id = ${brandId} and organization_id = ${organizationId}
        returning id
      `,
      "The review's decision is not in this brand, so nothing was changed.",
    );
    if (review.creative_id) {
      expectOneRow(
        await tx`
          update creative_records set status = ${nextStatus}, updated_at = now()
          where id = ${review.creative_id} and brand_id = ${brandId} and organization_id = ${organizationId}
          returning id
        `,
        "The review's creative is not in this brand, so nothing was changed.",
      );
      if (action === "reject") {
        await tx`
          insert into rejections (id, organization_id, brand_id, creative_id, decision_id, reason_code, note, rejected_by)
          values (
            ${id()}, ${organizationId}, ${brandId}, ${review.creative_id}, ${review.decision_id},
            ${input.reasonCode}, ${input.note}, ${input.userId}
          )
        `;
      }
    }
    // The review's opportunity must be in this brand, or the whole action is refused and rolled back. A rejected review dismisses only an
    // open idea: an idea already accepted or briefed keeps its status, because its brief is written from it (security review, finding 11).
    if (review.opportunity_id && action === "reject") {
      const [linked] = await tx<{ status: string }>`
        select status from opportunities where id = ${review.opportunity_id} and brand_id = ${brandId} and organization_id = ${organizationId} limit 1
      `;
      if (!linked) throw new Error("The review's opportunity is not in this brand, so nothing was changed.");
      if (linked.status === "open") {
        await tx`
          update opportunities set status = 'dismissed'
          where id = ${review.opportunity_id} and brand_id = ${brandId} and organization_id = ${organizationId} and status = 'open'
        `;
      }
    }
    await audit(tx, {
      organizationId,
      brandId,
      actorId: input.userId,
      action: action === "approve" ? "review.approved" : "review.rejected",
      objectType: "review",
      objectId: review.id,
      metadata: { reason: input.reasonCode },
    });
  });
}

/** An UPDATE that must reach exactly one row. Any other count throws inside the transaction, so every earlier write rolls back. */
function expectOneRow(rows: unknown[], message: string): void {
  if (rows.length !== 1) throw new Error(message);
}

export const publishToPlatform = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ brandId: clip(objectInput(input).brandId, 80, "Brand", true) }))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const access = await requireBrand(sql, context.userId, data.brandId, "admin");
    const result = publishCreative();
    const detail = "detail" in result ? result.detail : "Publishing returned an unexpected state.";
    await notify(sql, access.organizationId, data.brandId, "integration.unavailable", detail);
    await audit(sql, {
      organizationId: access.organizationId,
      brandId: data.brandId,
      actorId: context.userId,
      action: "integration.unavailable",
      objectType: "brand",
      objectId: data.brandId,
      metadata: { provider: "publishing" },
    });
    return { ...result, autoPublish: mayAutoPublish("autonomous") };
  });
