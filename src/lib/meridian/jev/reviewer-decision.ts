/**
 * Canonical JEV Decision & Reviewer Enums and Centralized Gate Policy
 *
 * Implements Section P0.2 of Hardening / Release-Blocker Fixes:
 * - Canonical JevDecision and ReviewerDecision enums (no raw string comparisons)
 * - evaluateJevGate(decision) centralized policy
 */

export const JevDecision = {
  APPROVE: "APPROVE",
  AUTO_APPROVE: "AUTO_APPROVE",
  HUMAN_REVIEW: "HUMAN_REVIEW",
  REJECT: "REJECT",
} as const;

export type JevDecision = (typeof JevDecision)[keyof typeof JevDecision];

export const ReviewerDecision = {
  APPROVE: "APPROVE",
  REJECT: "REJECT",
  REVISION: "REVISION",
} as const;

export type ReviewerDecision = (typeof ReviewerDecision)[keyof typeof ReviewerDecision];

export interface JevDecisionRecord {
  decision: string;
  reviewerDecision?: string | null;
}

export type JevGateResult =
  | {
      status: "ALLOW";
    }
  | {
      status: "BLOCK";
      reason: string;
    }
  | {
      status: "REQUIRE_HUMAN";
      reason: string;
    };

/**
 * Centralized policy evaluation for any JEV decision record.
 * Handles case-normalization and alias reconciliation.
 */
export function evaluateJevGate(decision: JevDecisionRecord): JevGateResult {
  const rawDec = String(decision.decision || "").trim().toUpperCase();
  const rawRev = decision.reviewerDecision ? String(decision.reviewerDecision).trim().toUpperCase() : null;

  // 1. REJECT is an immediate hard block
  if (rawDec === JevDecision.REJECT || rawDec === "REJECTED") {
    return {
      status: "BLOCK",
      reason: "JEV rejected the creative",
    };
  }

  // 2. HUMAN_REVIEW requires explicit human approval
  if (rawDec === JevDecision.HUMAN_REVIEW || rawDec === "REVIEW" || rawDec === "PENDING_REVIEW") {
    if (rawRev === ReviewerDecision.APPROVE || rawRev === "APPROVED") {
      return {
        status: "ALLOW",
      };
    }
    if (rawRev === ReviewerDecision.REJECT || rawRev === "REJECTED") {
      return {
        status: "BLOCK",
        reason: "Reviewer rejected the creative during human review",
      };
    }
    return {
      status: "REQUIRE_HUMAN",
      reason: "Human approval required",
    };
  }

  // 3. Explicit APPROVE or AUTO_APPROVE is allowed
  if (rawDec === JevDecision.APPROVE || rawDec === JevDecision.AUTO_APPROVE || rawDec === "APPROVED") {
    return {
      status: "ALLOW",
    };
  }

  // 4. Default: fail closed on unrecognized decision status
  return {
    status: "BLOCK",
    reason: `Unrecognized or unadmitted JEV decision status: '${decision.decision}'`,
  };
}

export type NormalizedReviewerDecision = "approved" | "rejected" | "";

/** Database reviews use approve/reject; API snapshots use approved/rejected. */
export function normalizeReviewerDecision(value: string | null | undefined): NormalizedReviewerDecision {
  if (!value) return "";
  const upper = String(value).trim().toUpperCase();
  if (upper === "APPROVE" || upper === "APPROVED") return "approved";
  if (upper === "REJECT" || upper === "REJECTED") return "rejected";
  return "";
}
