/**
 * Plan lineage (P3a). A CreativePlan is authoritative only when it records the persisted JEV decision it came from
 * and the evidence refs that decision cited. A plan without lineage is refused. It is never produced with a
 * placeholder source id, because a placeholder would let an unsourced recommendation look evidence-backed.
 */
export interface PlanLineage {
  /** The persisted jev_decisions id the plan was produced under, as loaded by the M2 gate. */
  decisionId: string;
  /** Evidence refs the decision cited. Deliverables require at least one (see requireCitedDeliverables). */
  evidenceRefs: string[];
}

export function validatePlanLineage(value: unknown): PlanLineage {
  if (!value || typeof value !== "object") {
    throw new Error("Creative plan refused: it has no JEV decision lineage.");
  }
  const input = value as { decisionId?: unknown; evidenceRefs?: unknown };
  const decisionId = typeof input.decisionId === "string" ? input.decisionId.trim() : "";
  if (!decisionId) {
    throw new Error("Creative plan refused: its lineage names no persisted JEV decision.");
  }
  if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.some((ref) => typeof ref !== "string" || !ref.trim())) {
    throw new Error("Creative plan refused: its lineage lists evidence that is not a list of ids.");
  }
  return { decisionId, evidenceRefs: [...new Set(input.evidenceRefs as string[])] };
}

/** A plan that produces deliverables must cite the evidence its decision used. An abstained plan may cite none. */
export function requireCitedDeliverables(lineage: PlanLineage, deliverableCount: number): void {
  if (deliverableCount > 0 && lineage.evidenceRefs.length === 0) {
    throw new Error("Creative plan refused: it produces deliverables, but its decision cites no evidence.");
  }
}
