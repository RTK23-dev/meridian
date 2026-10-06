import type { ReviewerRow } from "./propose.ts";

export function calibrationVisible(
  row: { organizationId: string; brandId: string },
  caller: { organizationId: string; brandId: string },
): boolean {
  return row.organizationId === caller.organizationId && row.brandId === caller.brandId;
}

export function reviewerRowsFromStored(rows: { probability: number; reviewerDecision: string | null }[]): ReviewerRow[] {
  return rows
    .filter((row) => row.reviewerDecision === "approve" || row.reviewerDecision === "reject")
    .filter((row) => Number.isFinite(row.probability))
    .map((row) => ({ probability: row.probability, reviewerApproved: row.reviewerDecision === "approve" }));
}

/** An open proposal is kept. Approval is a separate action and does not happen here. */
export function proposalCreateDecision(existingStatuses: string[]): "create" | "already_open" {
  return existingStatuses.includes("proposed") ? "already_open" : "create";
}
