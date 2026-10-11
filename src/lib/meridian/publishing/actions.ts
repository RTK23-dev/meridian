import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { mayAutoPublish, publishCreative } from "@/lib/meridian/providers/contracts";
import { isReviewReasonCode, reviewReasonOptions } from "../reviews/reasons.ts";
import { loadReviewPage, reviewPage } from "../reviews/listing.ts";
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
    const rows = await sql<{ id: string; decision_id: string; creative_id: string | null; opportunity_id: string | null }>`
      select id, decision_id, creative_id, opportunity_id from reviews
      where id = ${data.reviewId} and brand_id = ${data.brandId} and organization_id = ${access.organizationId} and status = 'open'
      limit 1
    `;
    const review = rows[0];
    if (!review) throw new Error("That review is not open.");
    await sql`
      update reviews set status = ${data.action === "approve" ? "approved" : "rejected"} where id = ${review.id}
    `;
    await sql`
      update jev_decisions set
        reviewer_id = ${context.userId},
        reviewer_decision = ${data.action},
        reviewer_note = ${data.note},
        reviewed_at = now()
      where id = ${review.decision_id}
    `;
    if (review.creative_id) {
      await sql`
        update creative_records set status = ${data.action === "approve" ? "approved" : "rejected"}, updated_at = now()
        where id = ${review.creative_id}
      `;
      if (data.action === "reject") {
        await sql`
          insert into rejections (id, organization_id, brand_id, creative_id, decision_id, reason_code, note, rejected_by)
          values (
            ${id()}, ${access.organizationId}, ${data.brandId}, ${review.creative_id}, ${review.decision_id},
            ${data.reasonCode}, ${data.note}, ${context.userId}
          )
        `;
      }
    }
    if (review.opportunity_id && data.action === "reject") {
      await sql`update opportunities set status = 'dismissed' where id = ${review.opportunity_id}`;
    }
    await audit(sql, {
      organizationId: access.organizationId,
      brandId: data.brandId,
      actorId: context.userId,
      action: data.action === "approve" ? "review.approved" : "review.rejected",
      objectType: "review",
      objectId: review.id,
      metadata: { reason: data.reasonCode },
    });
    return { ok: true };
  });

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
