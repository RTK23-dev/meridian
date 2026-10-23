// The approval of a paused plan's budget (owner direction 2026-10-23). A run that reaches its budget pauses and waits for an approval. An
// approval raises the budget the run is held to, and the user starts the run again. The orchestrator cannot raise a budget: only an approval
// does, and the server function that calls this checks that the caller is a workspace admin.
//
// The run's target is the lower of the plan's own budget and the budget the user set (envelope.ts). Raising only one of them would change
// nothing, so an approval sets both: the set budget becomes the approved amount, and the plan's budget becomes at least that amount.
//
// Every approval is recorded (decision D13, migration 0118). The plan's update and its audit row are one statement, so an approval without
// its record cannot happen, and a refused approval writes neither.

import type { Sql } from "../../lib/meridian/learning/store.ts";
import { getPlan } from "./store.ts";

export type ApprovalOutcome =
  | { status: "not_found" }
  | { status: "refused"; reasons: string[] }
  | { status: "approved"; previousUsd: number; budgetUsd: number };

/** One recorded approval. The reason is the pause reason the plan showed at the time, as stored (migration 0118). */
export type BudgetApproval = {
  id: string;
  planId: string;
  actorId: string;
  previousUsd: number;
  approvedUsd: number;
  reason: string;
  createdAt: string;
};

/**
 * Raise a paused plan's budget to the amount approved, and record who approved it. Refused unless the plan is paused for an approval, and
 * unless the amount is above the budget the plan has now. A refused approval writes nothing.
 *
 * The plan's update and its audit row are one statement (decision D13). The statement raises the plan only while it is still paused at the
 * budget read above, so an approval that meets a change is refused rather than applied over it. The pause reason is read in the same
 * statement, from the plan's last paused event (execute.ts writes it there, and run.ts stores it before the plan reads as paused).
 */
export async function approvePlanBudget(
  sql: Sql,
  opts: { organizationId: string; planId: string; budgetUsd: number; actorId: string },
): Promise<ApprovalOutcome> {
  const stored = await getPlan(sql, opts.organizationId, opts.planId);
  if (stored === null) return { status: "not_found" };
  if (stored.status !== "paused") {
    return { status: "refused", reasons: [`the plan is ${stored.status}; only a plan paused for an approval can be approved`] };
  }
  if (stored.plan === null) return { status: "refused", reasons: ["the plan has no checked plan to approve"] };
  if (!Number.isFinite(opts.budgetUsd) || !(opts.budgetUsd > stored.budgetUsd)) {
    return { status: "refused", reasons: [`the approved budget must be above the $${stored.budgetUsd.toFixed(4)} the plan has now`] };
  }

  const auditId = `approval_${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
  const rows = (await sql`
    with prior as (
      select p.budget_usd, (
        select e.reason from orchestrator_plan_events e
        where e.plan_id = p.id and e.state = 'paused'
        order by e.seq desc limit 1
      ) as pause_reason
      from orchestrator_plans p
      where p.id = ${opts.planId} and p.organization_id = ${opts.organizationId}
        and p.status = 'paused' and p.plan is not null and p.budget_usd = ${stored.budgetUsd}::numeric
    ),
    raised as (
      update orchestrator_plans
      set budget_usd = ${opts.budgetUsd}::numeric,
          plan = jsonb_set(plan, '{budgetUsd}', to_jsonb(greatest((plan->>'budgetUsd')::numeric, ${opts.budgetUsd}::numeric))),
          updated_at = now()
      where id = ${opts.planId} and organization_id = ${opts.organizationId}
        and status = 'paused' and plan is not null
        and budget_usd = ${stored.budgetUsd}::numeric and budget_usd < ${opts.budgetUsd}::numeric
      returning id
    )
    insert into orchestrator_budget_approvals (id, organization_id, plan_id, actor_id, previous_budget_usd, approved_budget_usd, reason)
    select ${auditId}, ${opts.organizationId}, ${opts.planId}, ${opts.actorId},
      prior.budget_usd, ${opts.budgetUsd}::numeric, left(coalesce(prior.pause_reason, ''), 500)
    from prior
    where exists (select 1 from raised)
    returning previous_budget_usd
  `) as Array<{ previous_budget_usd: unknown }>;

  const row = rows[0];
  if (row === undefined) return { status: "refused", reasons: ["the plan changed while the approval was made, so nothing was changed"] };
  return { status: "approved", previousUsd: Number(row.previous_budget_usd), budgetUsd: opts.budgetUsd };
}

/**
 * A plan's budget approvals, newest first, for the organization. Empty when the plan is not the organization's: the rows are scoped by the
 * organization, so another organization reads none.
 */
export async function listBudgetApprovals(sql: Sql, organizationId: string, planId: string, limit: number): Promise<BudgetApproval[]> {
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const rows = (await sql`
    select id, plan_id, actor_id, previous_budget_usd, approved_budget_usd, reason, created_at
    from orchestrator_budget_approvals
    where organization_id = ${organizationId} and plan_id = ${planId}
    order by created_at desc, id desc limit ${bounded}
  `) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    planId: String(row.plan_id),
    actorId: String(row.actor_id),
    previousUsd: Number(row.previous_budget_usd),
    approvedUsd: Number(row.approved_budget_usd),
    reason: String(row.reason),
    createdAt: timeOf(row.created_at),
  }));
}

/** A stored time as ISO text with its milliseconds. A driver may return a Date, and String() of a Date drops the milliseconds. */
function timeOf(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}
