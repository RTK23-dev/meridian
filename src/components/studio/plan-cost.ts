/**
 * The cost of a creative plan as the plan states it. Pure. A missing or non-finite value is reported as not returned, never as
 * zero, and a plan with unpriced deliverables says that its total is partial.
 */

export type PlanCostSource = {
  estimatedCostUsd?: number;
  plan: { estimatedCost?: { totalEstimatedUsd?: number; unpricedDeliverableIds?: string[] } } | null;
};

export function planCostText(source: PlanCostSource): string {
  const cost = source.estimatedCostUsd ?? source.plan?.estimatedCost?.totalEstimatedUsd;
  const unpriced = source.plan?.estimatedCost?.unpricedDeliverableIds?.length ?? 0;
  if (typeof cost !== "number" || !Number.isFinite(cost)) return "Not returned by the provider";
  return `$${cost.toFixed(2)} USD${unpriced > 0 ? `. Partial: ${unpriced} deliverable${unpriced === 1 ? " has" : "s have"} no price` : ""}`;
}
