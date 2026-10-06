export type NormalizedReviewerDecision = "approved" | "rejected" | "";

/** Database reviews use approve/reject; API snapshots use approved/rejected. */
export function normalizeReviewerDecision(value: string | null | undefined): NormalizedReviewerDecision {
  if (value === "approve" || value === "approved") return "approved";
  if (value === "reject" || value === "rejected") return "rejected";
  return "";
}
