/**
 * The JEV decision a creative's judgment is recorded under. A review or rejection row references a jev_decisions row
 * (reviews.decision_id and rejections.decision_id), so the id returned for a judgment must name one of the rows the judgment
 * wrote. The engine gate writes its own record (decision_gate_records) and that id is returned separately as gateRecordId. It
 * is never a decision id.
 */

import type { PolicyOutcome } from "../decisions/policy.ts";

export type RecordedDecision = { id: string; decision: PolicyOutcome };

const SEVERITY: Record<PolicyOutcome, number> = { AUTO_APPROVE: 0, HUMAN_REVIEW: 1, REJECT: 2 };

/**
 * The decision row a judgment points at: the first recorded decision whose outcome is the judgment's rollup, or else the most
 * severe recorded decision. Empty when no decision was recorded.
 */
export function judgmentDecisionId(rollup: PolicyOutcome, recorded: readonly RecordedDecision[]): string {
  const matching = recorded.find((item) => item.decision === rollup);
  if (matching) return matching.id;
  let worst: RecordedDecision | undefined;
  for (const item of recorded) {
    if (!worst || SEVERITY[item.decision] > SEVERITY[worst.decision]) worst = item;
  }
  return worst?.id ?? "";
}
