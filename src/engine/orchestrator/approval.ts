// The approval of a paused plan's budget (owner direction 2026-10-23). A run that reaches its allowance pauses and waits for an approval.
// An approval raises the budget the run is held to, and the user starts the run again. The orchestrator cannot raise a budget: only an
// approval does, and the server function that calls this checks that the caller is a workspace admin.
//
// The run's target is the lower of the plan's own budget and the budget the user set (envelope.ts). Raising only one of them would change
// nothing, so an approval sets both: the set budget becomes the approved amount, and the plan's budget becomes at least that amount.

import type { Sql } from "../../lib/meridian/learning/store.ts";
import { orchestratorPlanSchema } from "./contracts.ts";
import { getPlan } from "./store.ts";

export type ApprovalOutcome =
  | { status: "not_found" }
  | { status: "refused"; reasons: string[] }
  | { status: "approved"; previousUsd: number; budgetUsd: number };

/**
 * Raise a paused plan's budget to the amount approved. Refused unless the plan is paused for an approval, and unless the amount is above the
 * budget the plan has now. The write is conditional on the plan still being paused, so a run that started in between is not changed.
 */
export async function approvePlanBudget(sql: Sql, opts: { organizationId: string; planId: string; budgetUsd: number }): Promise<ApprovalOutcome> {
  const stored = await getPlan(sql, opts.organizationId, opts.planId);
  if (stored === null) return { status: "not_found" };
  if (stored.status !== "paused") {
    return { status: "refused", reasons: [`the plan is ${stored.status}; only a plan paused for an approval can be approved`] };
  }
  if (stored.plan === null) return { status: "refused", reasons: ["the plan has no checked plan to approve"] };
  if (!(opts.budgetUsd > stored.budgetUsd)) {
    return { status: "refused", reasons: [`the approved budget must be above the $${stored.budgetUsd.toFixed(4)} the plan has now`] };
  }

  const plan = orchestratorPlanSchema.parse({ ...stored.plan, budgetUsd: Math.max(stored.plan.budgetUsd, opts.budgetUsd) });
  const rows = (await sql`
    update orchestrator_plans
    set budget_usd = ${opts.budgetUsd}, plan = ${JSON.stringify(plan)}::jsonb, updated_at = now()
    where id = ${opts.planId} and organization_id = ${opts.organizationId} and status = 'paused'
    returning id
  `) as Array<{ id: string }>;
  if (rows.length === 0) return { status: "refused", reasons: ["the plan changed while the approval was made, so nothing was changed"] };
  return { status: "approved", previousUsd: stored.budgetUsd, budgetUsd: opts.budgetUsd };
}
