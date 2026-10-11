/**
 * The input of a studio variant review, checked on the server before the review is recorded. A rejection must carry one of the
 * reason codes on the server list (REVIEW_REASON_CODES). Free text is refused, so a stored rejection always names a code the
 * review list can show and count.
 */
import { REVIEW_REASON_CODES } from "../publishing/actions.ts";

export type VariantReviewInput = {
  brandId: string;
  creativeId: string;
  action: "approve" | "reject" | "revision";
  reasonCode: string;
  note: string;
};

export function parseVariantReview(body: Record<string, unknown>): VariantReviewInput {
  const action = typeof body.action === "string" ? body.action.trim().slice(0, 80) : "";
  if (action !== "approve" && action !== "reject" && action !== "revision") throw new Error("Choose approve, reject, or revision.");
  const reasonCode = typeof body.reasonCode === "string" ? body.reasonCode.trim().slice(0, 40) : "";
  if (action === "reject" && !(REVIEW_REASON_CODES as readonly string[]).includes(reasonCode)) {
    throw new Error("Choose a rejection reason from the review list. Free text is not accepted as a reason.");
  }
  const brandId = typeof body.brandId === "string" ? body.brandId.trim().slice(0, 80) : "";
  const creativeId = typeof body.creativeId === "string" ? body.creativeId.trim().slice(0, 80) : "";
  if (!brandId || !creativeId) throw new Error("Choose a variant.");
  return {
    brandId,
    creativeId,
    action,
    reasonCode,
    note: typeof body.note === "string" ? body.note.trim().slice(0, 400) : "",
  };
}
