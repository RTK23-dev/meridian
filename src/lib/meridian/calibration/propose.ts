export type Thresholds = {
  autoApprove: number;
  humanReview: number;
};

export type ReviewerRow = {
  probability: number;
  reviewerApproved: boolean;
};

export type ThresholdProposal = {
  questionId: string;
  current: Thresholds;
  proposed: Thresholds;
  samples: number;
  disagreement: number;
  applied: false;
};

/**
 * A proposal is not a threshold change.
 * Fewer than 30 reviewer rows produces no proposal.
 */
export function proposeThresholdChange(input: {
  questionId: string;
  current: Thresholds;
  rows: ReviewerRow[];
}): { status: "insufficient" | "proposed"; proposal: ThresholdProposal | null } {
  if (input.rows.length < 30) {
    return { status: "insufficient", proposal: null };
  }
  const approved = input.rows.filter((row) => row.reviewerApproved);
  const rejected = input.rows.filter((row) => !row.reviewerApproved);
  const mean = (rows: ReviewerRow[]) => rows.reduce((sum, row) => sum + row.probability, 0) / rows.length;
  const approvedMean = approved.length ? mean(approved) : input.current.autoApprove;
  const rejectedMean = rejected.length ? mean(rejected) : input.current.humanReview;
  const disagreement = Math.abs(approvedMean - rejectedMean);
  if (disagreement < 0.15 || approved.length < 10 || rejected.length < 10) {
    return { status: "insufficient", proposal: null };
  }
  const proposed = {
    autoApprove: clamp(Math.max(input.current.autoApprove, approvedMean)),
    humanReview: clamp(Math.min(input.current.humanReview, rejectedMean)),
  };
  return {
    status: "proposed",
    proposal: {
      questionId: input.questionId,
      current: input.current,
      proposed,
      samples: input.rows.length,
      disagreement: Math.round(disagreement * 1000) / 1000,
      applied: false,
    },
  };
}

export type ApprovedThresholds = {
  questionId: string;
  version: number;
  thresholds: Thresholds;
  approvedBy: string;
  appliedAutomatically: false;
};

/** Approval versions the numbers. decide() keeps its previous thresholds until a caller passes these in. */
export function approveThresholdChange(proposal: ThresholdProposal, approvedBy: string, previousVersion: number): ApprovedThresholds {
  if (proposal.applied !== false) throw new Error("A proposal cannot already be applied.");
  if (!approvedBy.trim()) throw new Error("Threshold approval needs a person.");
  return {
    questionId: proposal.questionId,
    version: previousVersion + 1,
    thresholds: proposal.proposed,
    approvedBy: approvedBy.trim(),
    appliedAutomatically: false,
  };
}

function clamp(value: number): number {
  return Math.round(Math.min(0.99, Math.max(0.01, value)) * 1000) / 1000;
}
