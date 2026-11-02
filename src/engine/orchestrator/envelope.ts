// The run's line (owner direction 2026-10-23, decision D12: a budget is a line, not a tolerance).
//
// A plan's money is bounded by one number. The line is the lower of the plan's own budget and the budget the user set: the orchestrator
// cannot raise the user's budget. A paid step starts only while the committed spend is below the line (budget/line.ts). A plan that asks
// for more than the user set is a plan, with a note; the run stops at the line. Pure.

/** The line of a plan: the lower of its own budget and the budget the user set. */
export function lineOf(planBudgetUsd: number, setBudgetUsd: number): number {
  return Math.min(planBudgetUsd, setBudgetUsd);
}

/** A plan that asks for more than the user set. The run stops at the user's budget. A note, never a refusal. */
export function planAskNote(planBudgetUsd: number, setBudgetUsd: number): string | null {
  if (planBudgetUsd <= setBudgetUsd) return null;
  return `the plan asks for $${planBudgetUsd.toFixed(4)}; the run stops at the $${setBudgetUsd.toFixed(4)} budget you set`;
}
