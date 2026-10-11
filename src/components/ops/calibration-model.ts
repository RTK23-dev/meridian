/**
 * Pure rules for the calibration screen. The decision rules below describe the server's code in plain words (propose.ts and
 * decideCalibration). They are shown, not enforced here, so a change to the server needs a change to this text too.
 */
import type { Baseline, CalibrationProposalView, ThresholdChange, ThresholdPair } from "@/lib/meridian/calibration/versions";
import { statusLabel } from "../../lib/copy.ts";

/** How a proposal is made and decided. Matches proposeThresholdChange, proposalCreateDecision and approveThresholdChange. */
export const DECISION_RULES: readonly string[] = [
  "A proposal needs at least 30 reviewer outcomes for this brand. Outcomes without an approve or reject decision are not counted.",
  "Those outcomes must include at least 10 approvals and at least 10 rejections.",
  "The average decision probability of the approvals and of the rejections must differ by at least 0.15.",
  "Auto-approve can only move up, to the average of the approvals. Human review can only move down, to the average of the rejections.",
  "Every proposed value stays between 0.01 and 0.99.",
  "Only one proposal can be open for a brand at a time. No new proposal is made while one is waiting for a decision.",
  "A proposal changes no threshold on its own. Approving it writes the next threshold version. Rejecting it changes nothing.",
];

export const FIELD_LABELS: Record<keyof ThresholdPair, string> = {
  autoApprove: "Auto-approve",
  humanReview: "Human review",
};

function value(number: number): string {
  return number.toFixed(3);
}

export function thresholdText(thresholds: ThresholdPair | null): string {
  if (!thresholds) return "Not recorded";
  return `Auto-approve ${value(thresholds.autoApprove)} · Human review ${value(thresholds.humanReview)}`;
}

/** The active baseline in plain words. An unreadable version says so, and names the fallback the decision path uses. */
export function baselineCopy(baseline: Baseline, codeDefault: ThresholdPair): { title: string; detail: string; warning: boolean } {
  if (baseline.source === "approved") {
    return { title: `Version ${baseline.version} is active`, detail: thresholdText(baseline.thresholds), warning: false };
  }
  if (baseline.source === "code_default") {
    return { title: "No approved version. The code defaults are active.", detail: thresholdText(codeDefault), warning: false };
  }
  return {
    title: `Version ${baseline.version} cannot be read`,
    detail: `The decision path uses the code defaults until a readable version exists: ${thresholdText(codeDefault)}.`,
    warning: true,
  };
}

/** The change as a signed number, or "No change" when the proposed value equals the baseline. */
export function changeText(change: ThresholdChange): string {
  if (!change.changed) return "No change";
  return `${change.change > 0 ? "+" : ""}${value(change.change)}`;
}

export function baselineMatchText(baselineChanged: boolean | null): string {
  if (baselineChanged === true) return "The active baseline changed after this proposal was made. The change shown is against the current baseline.";
  if (baselineChanged === false) return "Made from the active baseline as it is now.";
  return "The baseline this proposal was made from is not recorded.";
}

export function evidenceText(evidence: { samples: number | null; disagreement: number | null }): { samples: string; disagreement: string } {
  return {
    samples: evidence.samples == null ? "Not recorded" : `${evidence.samples.toLocaleString()} reviewer outcomes`,
    disagreement: evidence.disagreement == null ? "Not recorded" : value(evidence.disagreement),
  };
}

export function proposalStatusText(status: string): string {
  if (status === "proposed") return "Waiting for a decision";
  if (status === "approved") return "Approved";
  if (status === "rejected") return "Rejected";
  return statusLabel(status);
}

/**
 * Which decision controls show. Only a proposal still waiting can be decided, only an admin decides, and a proposal whose
 * proposed values cannot be read can be rejected but not approved.
 */
export function decisionControls(
  proposal: Pick<CalibrationProposalView, "canDecide" | "changes">,
  canAdmin: boolean,
): { approve: boolean; reject: boolean; note: string | null } {
  if (!proposal.canDecide) return { approve: false, reject: false, note: null };
  if (!canAdmin) return { approve: false, reject: false, note: "Only an admin can approve or reject this proposal." };
  if (proposal.changes === null) {
    return { approve: false, reject: true, note: "The proposed values cannot be read, so this proposal cannot be approved. It can be rejected." };
  }
  return { approve: true, reject: true, note: null };
}
