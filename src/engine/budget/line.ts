// The budget line (owner direction, 2026-10-23, decision D12: a budget is a line, not a tolerance).
//
// A paid step may start only while the committed spend is below its budget. Committed spend is what has settled, plus what is held for
// calls in flight or queued, plus what failed calls held. A call already in flight when the line is crossed finishes, so the spend can
// pass the line by that call's cost; no step starts after it. Pure: no database, no provider. Money is in USD, rounded up to four
// decimals, as reservations carry it.

/** Rounds up to four decimals, the precision reservations carry. The epsilon keeps an exact value from rounding up a step. */
export function roundUpUsd(value: number): number {
  return Math.ceil(value * 10000 - 1e-9) / 10000;
}

/** A sum within this of a line counts as at it: the float error of a sum must not decide whether a step starts. */
const EPSILON_USD = 1e-9;

/** Whether a paid step may start: the committed spend is below the line. A spend at the line has reached it. */
export function startsBelowLine(committedUsd: number, lineUsd: number): boolean {
  return committedUsd < lineUsd - EPSILON_USD;
}

/** Where a total sits against a line: at or under it is within the budget; past it, over. */
export type BudgetPosition = "within_budget" | "over_budget";

export function positionOfLine(totalUsd: number, lineUsd: number): BudgetPosition {
  return totalUsd <= lineUsd + EPSILON_USD ? "within_budget" : "over_budget";
}
