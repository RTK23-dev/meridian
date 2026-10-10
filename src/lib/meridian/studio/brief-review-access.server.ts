/**
 * The access-checked entry points for the brief review. The role is the caller's own, read from the brand membership here,
 * so the server enforces who may review; the form only shows the control. The core review logic is in brief-review.server.ts.
 */
import type { Sql } from "../learning/store.ts";
import { requireBrand } from "../machine-shared.ts";
import { BRIEF_REVIEW_MINIMUM_ROLE, loadBriefReviewDisclosure, reviewBrief } from "./brief-review.server.ts";

/** The disclosure a member of the brand may read. Anyone who can see the brief can see why it is held. */
export async function getBriefReviewForUser(sql: Sql, userId: string, input: { brandId: string; briefId: string }) {
  const access = await requireBrand(sql, userId, input.brandId, "member");
  return loadBriefReviewDisclosure(sql, { organizationId: access.organizationId, brandId: input.brandId, briefId: input.briefId });
}

/** The review action. The role is the caller's own, checked here on the server; the form only shows the control. */
export async function reviewBriefForUser(
  sql: Sql,
  userId: string,
  input: { brandId: string; briefId: string; action: "approve" | "reject"; reason: string; acknowledged: boolean },
) {
  const access = await requireBrand(sql, userId, input.brandId, BRIEF_REVIEW_MINIMUM_ROLE);
  return reviewBrief(sql, {
    organizationId: access.organizationId,
    brandId: input.brandId,
    briefId: input.briefId,
    reviewerId: userId,
    reviewerRole: access.role,
    action: input.action,
    reason: input.reason,
    acknowledged: input.acknowledged,
  });
}
