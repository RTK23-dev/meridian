// The approval of a paused plan's budget (owner direction 2026-10-23). A run that reaches a budget line pauses and waits for an approval. An
// approval raises the line the run stopped at, and the user starts the run again. The orchestrator cannot raise a budget: only an approval
// does, and the server function that calls this checks that the caller is a workspace admin.
//
// There are two kinds of line (D11, D3, D12). A total pause is approved as the plan's budget: the run's target is the lower of the plan's own
// budget and the budget the user set (envelope.ts), so an approval sets both. A category pause ("copy budget reached") is approved as that
// category's line in the brief, and nothing else changes: the run did not stop at the total, so the total is not raised. The approval names
// the category the pause is at, and only that one, so a total approval cannot clear a category pause, or a category approval a total one.
//
// Every approval is recorded (decision D13, migration 0118). The plan's update and its audit row are one statement, so an approval without
// its record cannot happen, and a refused approval writes neither. The audit table has no category column, so a category approval's record
// names the category in its reason; its previous and approved amounts are the category's line.

import type { Sql } from "../../lib/meridian/learning/store.ts";
import { BUDGET_CATEGORIES, type BudgetCategory } from "./categories.ts";
import { getPlan, type StoredPlan } from "./store.ts";

export type ApprovalOutcome =
  | { status: "not_found" }
  | { status: "refused"; reasons: string[] }
  | { status: "approved"; previousUsd: number; budgetUsd: number; category: BudgetCategory | null };

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

/** The pause reason of a category line: "<category> budget reached, project not finished" (execute.ts). Matched here and in the database. */
const CATEGORY_PAUSE = "^(copy|creative|voice) budget reached, project not finished";
const CATEGORY_PAUSE_RE = new RegExp(CATEGORY_PAUSE);

/**
 * The reason of a month pause: a call was refused because the workspace month is at its budget (budget/reserve.ts words both refusals so, and
 * the executor passes them on). A plan's budget does not raise the month, so no approval of the plan raises it.
 */
const MONTH_PAUSE = "the workspace month has committed|would take the workspace month to";
const MONTH_PAUSE_RE = new RegExp(MONTH_PAUSE);

/**
 * Why an approval of a month pause is refused. The month budget is set in settings, not on the plan, so no approval of the plan clears a pause
 * at the month line: the refusal says where the budget is raised.
 */
const MONTH_REFUSAL = "the workspace month is at its budget; raise the monthly budget in settings";

/** The brief's key of each category's line. categories.ts categoryBudgetsOf reads the same keys. */
const LINE_KEY: Record<BudgetCategory, string> = { copy: "copyBudgetUsd", creative: "creativeBudgetUsd", voice: "voiceBudgetUsd" };

type ApproveOpts = { organizationId: string; planId: string; budgetUsd: number; actorId: string };

/**
 * Raise the line a paused plan stopped at, and record who approved it. Refused unless the plan is paused for an approval, the approval names the
 * category of the pause (or names none for a total pause), and the amount is above the line the plan has now. A refused approval writes nothing.
 *
 * The statement raises the line only while the plan is still paused at the line read above, so an approval that meets a change is refused
 * rather than applied over it. The pause reason is read in the same statement, from the plan's last paused event (execute.ts writes it there,
 * and run.ts stores it before the plan reads as paused).
 */
export async function approvePlanBudget(
  sql: Sql,
  opts: ApproveOpts & { category?: BudgetCategory },
): Promise<ApprovalOutcome> {
  const stored = await getPlan(sql, opts.organizationId, opts.planId);
  if (stored === null) return { status: "not_found" };
  if (stored.status !== "paused") return refusedWith(`the plan is ${stored.status}; only a plan paused for an approval can be approved`);
  if (stored.plan === null) return refusedWith("the plan has no checked plan to approve");
  const category = opts.category ?? null;
  if (category !== null && !BUDGET_CATEGORIES.some((name) => name === category)) return refusedWith(`${category} is not a budget category`);

  // A month pause is not a line of the plan: no approval raises the workspace month, so every approval of it is refused, with the way to raise it.
  const pauseReason = await lastPauseReason(sql, opts.organizationId, opts.planId);
  if (pauseReason !== null && MONTH_PAUSE_RE.test(pauseReason)) return refusedWith(MONTH_REFUSAL);

  // The line the run stopped at, and the approval must name it: a category's line, or the total (no category).
  const pausedAt = categoryOfPause(pauseReason);
  if (pausedAt !== category) {
    if (pausedAt === null) return refusedWith(`the plan is paused at its plan budget, not its ${category} budget; approve it without a category`);
    if (category === null) return refusedWith(`the plan is paused at its ${pausedAt} budget; approve it with the ${pausedAt} category`);
    return refusedWith(`the plan is paused at its ${pausedAt} budget, not its ${category} budget`);
  }

  if (category === null) {
    if (!Number.isFinite(opts.budgetUsd) || !(opts.budgetUsd > stored.budgetUsd)) {
      return refusedWith(`the approved budget must be above the $${stored.budgetUsd.toFixed(4)} the plan has now`);
    }
    return approveTotal(sql, opts, stored);
  }
  const line = categoryLineOf(stored.brief, category);
  if (line === undefined) return refusedWith(`the brief sets no ${category} budget, so there is no ${category} line to raise`);
  if (!Number.isFinite(opts.budgetUsd) || !(opts.budgetUsd > line)) {
    return refusedWith(`the approved ${category} budget must be above the $${line.toFixed(4)} the plan has now`);
  }
  return approveCategory(sql, opts, stored, category, line);
}

/** Raises the plan's total: the set budget and the plan's own budget both go to the approved amount (D11). */
async function approveTotal(sql: Sql, opts: ApproveOpts, stored: StoredPlan): Promise<ApprovalOutcome> {
  const auditId = newAuditId();
  const rows = (await sql`
    with lastpause as (
      select e.plan_id, e.reason from orchestrator_plan_events e
      where e.plan_id = ${opts.planId} and e.state = 'paused'
      order by e.seq desc limit 1
    ),
    prior as (
      select p.id as plan_id, p.budget_usd, p.brief, lastpause.reason as pause_reason,
        substring(lastpause.reason from ${CATEGORY_PAUSE}::text) as pause_category,
        coalesce(lastpause.reason ~ ${MONTH_PAUSE}::text, false) as pause_month
      from orchestrator_plans p
      left join lastpause on lastpause.plan_id = p.id
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
        and exists (select 1 from prior where prior.pause_category is null and not prior.pause_month)
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
  if (row === undefined) return refusedWith("the plan changed while the approval was made, so nothing was changed");
  return { status: "approved", previousUsd: Number(row.previous_budget_usd), budgetUsd: opts.budgetUsd, category: null };
}

/**
 * Raises a category's line in the brief. The total is not touched. The audit row's amounts are the category's line, before and after, and its
 * reason names the category.
 */
async function approveCategory(sql: Sql, opts: ApproveOpts, stored: StoredPlan, category: BudgetCategory, line: number): Promise<ApprovalOutcome> {
  const auditId = newAuditId();
  const key = LINE_KEY[category];
  const rows = (await sql`
    with lastpause as (
      select e.plan_id, e.reason from orchestrator_plan_events e
      where e.plan_id = ${opts.planId} and e.state = 'paused'
      order by e.seq desc limit 1
    ),
    prior as (
      select p.id as plan_id, p.budget_usd, p.brief, lastpause.reason as pause_reason,
        substring(lastpause.reason from ${CATEGORY_PAUSE}::text) as pause_category,
        coalesce(lastpause.reason ~ ${MONTH_PAUSE}::text, false) as pause_month
      from orchestrator_plans p
      left join lastpause on lastpause.plan_id = p.id
      where p.id = ${opts.planId} and p.organization_id = ${opts.organizationId}
        and p.status = 'paused' and p.plan is not null and p.budget_usd = ${stored.budgetUsd}::numeric
    ),
    raised as (
      update orchestrator_plans
      set brief = jsonb_set(brief, ${`{${key}}`}::text[], to_jsonb(${opts.budgetUsd}::numeric)), updated_at = now()
      where id = ${opts.planId} and organization_id = ${opts.organizationId}
        and status = 'paused' and plan is not null and budget_usd = ${stored.budgetUsd}::numeric
        and (brief->>${key})::numeric = ${line}::numeric
        and exists (select 1 from prior where prior.pause_category = ${category}::text and not prior.pause_month)
      returning id
    )
    insert into orchestrator_budget_approvals (id, organization_id, plan_id, actor_id, previous_budget_usd, approved_budget_usd, reason)
    select ${auditId}, ${opts.organizationId}, ${opts.planId}, ${opts.actorId},
      (prior.brief->>${key})::numeric, ${opts.budgetUsd}::numeric,
      left(${`category ${category}; `}::text || coalesce(prior.pause_reason, ''), 500)
    from prior
    where exists (select 1 from raised)
    returning previous_budget_usd
  `) as Array<{ previous_budget_usd: unknown }>;

  const row = rows[0];
  if (row === undefined) return refusedWith("the plan changed while the approval was made, so nothing was changed");
  return { status: "approved", previousUsd: Number(row.previous_budget_usd), budgetUsd: opts.budgetUsd, category };
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

function refusedWith(reason: string): ApprovalOutcome {
  return { status: "refused", reasons: [reason] };
}

function newAuditId(): string {
  return `approval_${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
}

/** The category of a pause, from its reason's wording (CATEGORY_PAUSE), or null for a total pause or any other reason. */
function categoryOfPause(reason: string | null): BudgetCategory | null {
  const match = reason === null ? null : CATEGORY_PAUSE_RE.exec(reason);
  if (match === null) return null;
  return BUDGET_CATEGORIES.find((name) => name === match[1]) ?? null;
}

/** The reason of the plan's last paused event, or null. Read for the refusal's words only: the statement checks the pause again, atomically. */
async function lastPauseReason(sql: Sql, organizationId: string, planId: string): Promise<string | null> {
  const rows = (await sql`
    select e.reason from orchestrator_plan_events e
    join orchestrator_plans p on p.id = e.plan_id
    where e.plan_id = ${planId} and p.organization_id = ${organizationId} and e.state = 'paused'
    order by e.seq desc limit 1
  `) as Array<{ reason: unknown }>;
  const reason = rows[0]?.reason;
  return typeof reason === "string" ? reason : null;
}

/** The line a brief sets for a category, in USD, or undefined when it sets none. */
function categoryLineOf(brief: unknown, category: BudgetCategory): number | undefined {
  if (typeof brief !== "object" || brief === null) return undefined;
  const value = (brief as Record<string, unknown>)[LINE_KEY[category]];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** A stored time as ISO text with its milliseconds. A driver may return a Date, and String() of a Date drops the milliseconds. */
function timeOf(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}
