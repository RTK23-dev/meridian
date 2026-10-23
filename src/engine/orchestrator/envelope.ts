// The run's budget envelope (owner direction, 2026-10-23: budgets are safe limits, not hard limits).
//
// A plan's money is bounded by two numbers. The target is the lower of the plan's own budget and the budget the user set: the orchestrator
// cannot raise the user's budget. The allowance is the target plus its overrun tolerance (budget/tolerance.ts). Work may spend up to the
// allowance. Past it, the run waits for an approval at the step that would pass it. A small overrun is never a refusal. Pure.

import { allowanceUsd, budgetPosition, INITIAL_BUDGET_TOLERANCE, type BudgetPosition, type BudgetTolerance } from "../budget/tolerance.ts";
import { BUDGET_CATEGORIES, type BudgetCategory, type CategoryAmounts } from "./categories.ts";

export type BudgetEnvelope = { targetUsd: number; allowanceUsd: number; tolerance: BudgetTolerance };

/** The envelope of one amount: the target is the amount, and the allowance is the amount plus its tolerance. */
export function envelopeAt(targetUsd: number, tolerance: BudgetTolerance = INITIAL_BUDGET_TOLERANCE): BudgetEnvelope {
  return { targetUsd, allowanceUsd: allowanceUsd(targetUsd, tolerance), tolerance };
}

/** The envelope of a plan: the target is the lower of the two budgets, and the allowance is the target plus its tolerance. */
export function envelopeOf(planBudgetUsd: number, setBudgetUsd: number, tolerance: BudgetTolerance = INITIAL_BUDGET_TOLERANCE): BudgetEnvelope {
  return envelopeAt(Math.min(planBudgetUsd, setBudgetUsd), tolerance);
}

/** The envelope of each category the brief sets. A category it does not set is absent: only the plan's total applies to its steps. */
export function categoryEnvelopesOf(budgets: CategoryAmounts, tolerance: BudgetTolerance = INITIAL_BUDGET_TOLERANCE): Partial<Record<BudgetCategory, BudgetEnvelope>> {
  const envelopes: Partial<Record<BudgetCategory, BudgetEnvelope>> = {};
  for (const category of BUDGET_CATEGORIES) {
    const budget = budgets[category];
    if (budget !== undefined) envelopes[category] = envelopeAt(budget, tolerance);
  }
  return envelopes;
}

/** The allowance of each category that has an envelope. */
export function allowancesOf(envelopes: Partial<Record<BudgetCategory, BudgetEnvelope>>): CategoryAmounts {
  const allowances: CategoryAmounts = {};
  for (const category of BUDGET_CATEGORIES) {
    const envelope = envelopes[category];
    if (envelope !== undefined) allowances[category] = envelope.allowanceUsd;
  }
  return allowances;
}

/** Where a total sits against the envelope: within its target, within its tolerance, or past its allowance. */
export function positionOf(totalUsd: number, envelope: BudgetEnvelope): BudgetPosition {
  return budgetPosition(totalUsd, envelope.targetUsd, envelope.tolerance);
}

/** A plan that asks for more than the user set. The run is held to the user's budget and its tolerance. A note, never a refusal. */
export function planAskNote(planBudgetUsd: number, setBudgetUsd: number): string | null {
  if (planBudgetUsd <= setBudgetUsd) return null;
  return `the plan asks for $${planBudgetUsd.toFixed(4)}; the run is held to the $${setBudgetUsd.toFixed(4)} you set, plus its tolerance`;
}
