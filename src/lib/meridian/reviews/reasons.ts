/**
 * The reasons a reviewer can give for a rejection. The server checks a rejection against these codes, and it sends the
 * labels with the review list, so the screen does not carry its own copy of them.
 */

export const REVIEW_REASON_CODES = [
  "wrong_logo",
  "wrong_product",
  "unsupported_claim",
  "too_generic",
  "tone_mismatch",
  "bad_audience",
  "visual_mismatch",
  "duplicate",
  "too_similar",
  "policy_violation",
  "poor_brief",
  "too_aggressive",
  "other",
] as const;

export type ReviewReasonCode = (typeof REVIEW_REASON_CODES)[number];

export const REVIEW_REASON_LABELS: Record<ReviewReasonCode, string> = {
  wrong_logo: "Wrong logo",
  wrong_product: "Wrong product",
  unsupported_claim: "Unsupported claim",
  too_generic: "Too generic",
  tone_mismatch: "Tone does not match the brand",
  bad_audience: "Wrong audience",
  visual_mismatch: "Visual does not match the brief",
  duplicate: "Duplicate of another creative",
  too_similar: "Too similar to an existing creative",
  policy_violation: "Policy violation",
  poor_brief: "Brief is weak",
  too_aggressive: "Too aggressive",
  other: "Other",
};

export function isReviewReasonCode(value: string): value is ReviewReasonCode {
  return (REVIEW_REASON_CODES as readonly string[]).includes(value);
}

/** The options the rejection form offers, in the server's order, with the server's labels. */
export function reviewReasonOptions(): { code: ReviewReasonCode; label: string }[] {
  return REVIEW_REASON_CODES.map((code) => ({ code, label: REVIEW_REASON_LABELS[code] }));
}
