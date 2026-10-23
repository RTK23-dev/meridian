// The overrun tolerance on a budget (owner direction, 2026-10-23: budgets are safe limits, not hard limits).
//
// A budget is a target. Work may go past the target by a tolerance, the larger of a percentage of the target and a fixed number of cents.
// Past the allowance (the target plus the tolerance), work pauses and asks for approval. It is never refused for a small overrun, so one
// cent over never stops a video that is nearly done. The values are initial values, adjustable per workspace (orchestrator policy,
// migration 0114). Pure: no database, no provider. Money is in USD, rounded up to a hundredth of a cent, as reservations carry it.

export type BudgetTolerance = { percent: number; cents: number };

/** Initial values. Adjustable per workspace in Settings. */
export const INITIAL_BUDGET_TOLERANCE: BudgetTolerance = { percent: 10, cents: 25 };

/** Where a spend sits against its target: inside it, inside the tolerance, or past the allowance (which needs an approval). */
export type BudgetPosition = "within_target" | "within_tolerance" | "needs_approval";

/** Rounds up to four decimals, the precision reservations carry. The epsilon keeps an exact value from rounding up a step. */
export function roundUpUsd(value: number): number {
  return Math.ceil(value * 10000 - 1e-9) / 10000;
}

/** The tolerance in USD on a target: the larger of the percentage and the cents, rounded up. */
export function toleranceUsd(targetUsd: number, tolerance: BudgetTolerance): number {
  const share = (targetUsd * tolerance.percent) / 100;
  return roundUpUsd(Math.max(share, tolerance.cents / 100));
}

/** The allowance: the target plus its tolerance. */
export function allowanceUsd(targetUsd: number, tolerance: BudgetTolerance): number {
  return roundUpUsd(targetUsd + toleranceUsd(targetUsd, tolerance));
}

/** Where a total sits against a target. A total at or under the target is within it; at or under the allowance, within the tolerance. */
export function budgetPosition(totalUsd: number, targetUsd: number, tolerance: BudgetTolerance): BudgetPosition {
  const epsilon = 1e-9;
  if (totalUsd <= targetUsd + epsilon) return "within_target";
  if (totalUsd <= allowanceUsd(targetUsd, tolerance) + epsilon) return "within_tolerance";
  return "needs_approval";
}

/** Whether a further amount may start, given what has been spent or held: its total must not pass the allowance. */
export function mayStart(spentUsd: number, amountUsd: number, targetUsd: number, tolerance: BudgetTolerance): boolean {
  return budgetPosition(roundUpUsd(spentUsd + amountUsd), targetUsd, tolerance) !== "needs_approval";
}
