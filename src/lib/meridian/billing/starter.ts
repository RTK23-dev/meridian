// The starter limits: what one monthly amount turns into on the Billing page. Pure, so it can be tested without a database.
// Only a limit that is not set yet is part of the plan, so an amount a person already chose is never changed or lowered.
import type { BillingPage } from "./store.ts";
import type { LimitKind } from "./limits.ts";

export type StarterStep = { kind: LimitKind; brandId: string | null; value: number };

/** A decision's per-call cap is a fiftieth of the month, kept inside the range the page allows, in whole cents. */
export function decisionCapFor(monthlyUsd: number, range: { min: number; max: number }): number {
  const raw = Math.round((monthlyUsd / 50) * 100) / 100;
  return Math.min(range.max, Math.max(range.min, raw));
}

export function starterLimitPlan(page: Pick<BillingPage, "workspace" | "brands" | "ranges">, monthlyUsd: number): { steps: StarterStep[]; decisionCapUsd: number } {
  const decisionCapUsd = decisionCapFor(monthlyUsd, page.ranges.decision);
  const steps: StarterStep[] = [];
  if (page.workspace.monthlyBudgetUsd === null) steps.push({ kind: "workspace_monthly_budget", brandId: null, value: monthlyUsd });
  for (const brand of page.brands) {
    if (brand.brandBudgetUsd === null) steps.push({ kind: "brand_budget", brandId: brand.brandId, value: monthlyUsd });
  }
  if (page.workspace.decisionCapUsd === null && page.workspace.policyReadable) steps.push({ kind: "decision_cap", brandId: null, value: decisionCapUsd });
  return { steps, decisionCapUsd };
}
