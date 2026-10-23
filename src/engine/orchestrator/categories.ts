// The budget categories of a plan (owner direction 2026-10-23, D3). A category is the kind of work a set of paid steps does: copy is the
// text steps, creative is the image and video steps, and voice is the speech steps. A brief may set a budget for a category. A category it
// does not set is the orchestrator's to split under the plan's total. A step that makes no model call has no category. Pure.

// money.ts, not the contracts index: the index re-exports hash.ts, which needs Node's crypto, and the plan store that uses this module is
// reached from the browser bundle through the server functions. This module must stay free of Node-only imports.
import { sumUsd } from "../contracts/money.ts";
import type { NodeKind } from "./contracts.ts";

export const BUDGET_CATEGORIES = ["copy", "creative", "voice"] as const;
export type BudgetCategory = (typeof BUDGET_CATEGORIES)[number];

/** USD by category. A category that is absent has no amount of its own. */
export type CategoryAmounts = Partial<Record<BudgetCategory, number>>;

/** The category of a step, or null for a step that makes no model call. */
export function categoryOf(kind: NodeKind): BudgetCategory | null {
  switch (kind) {
    case "analysis":
    case "script":
      return "copy";
    case "visual":
    case "video":
    case "avatar":
      return "creative";
    case "voice":
      return "voice";
    default:
      return null;
  }
}

/** The category budgets a brief sets, in USD. A category the brief does not set is absent. */
export function categoryBudgetsOf(brief: { copyBudgetUsd?: number; creativeBudgetUsd?: number; voiceBudgetUsd?: number }): CategoryAmounts {
  const budgets: CategoryAmounts = {};
  if (brief.copyBudgetUsd !== undefined) budgets.copy = brief.copyBudgetUsd;
  if (brief.creativeBudgetUsd !== undefined) budgets.creative = brief.creativeBudgetUsd;
  if (brief.voiceBudgetUsd !== undefined) budgets.voice = brief.voiceBudgetUsd;
  return budgets;
}

/**
 * What a plan has spent in each category: the stored outputs, each with the category of its step, and the failed holds of its steps. A hold
 * takes its step's category, which is fixed for the step (an edit changes a step's model and params, never its kind). A hold for a step
 * that is not in the plan, or for a step with no category, is not in any category; it is still in the plan's total.
 */
export function categorySpentOf(
  nodes: ReadonlyArray<{ id: string; kind: NodeKind }>,
  outputsUsd: CategoryAmounts,
  holdsByNodeUsd: ReadonlyMap<string, number>,
): CategoryAmounts {
  const spent: CategoryAmounts = { ...outputsUsd };
  for (const node of nodes) {
    const category = categoryOf(node.kind);
    const hold = holdsByNodeUsd.get(node.id);
    if (category !== null && hold !== undefined) spent[category] = sumUsd([spent[category] ?? 0, hold]);
  }
  return spent;
}
