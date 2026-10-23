-- Every budget approval is recorded (owner direction 2026-10-23, decision D13). Numbered after 0117. Additive only.
--
-- An approval raises a paused plan's budget (approval.ts). Its audit row is written in the same statement as the plan's budget update, so an
-- approval without its record cannot happen, and a refused approval writes neither. The row keeps the actor, the budget the approval replaced,
-- the budget it set, and the pause reason the plan showed at the time. The table is new: nothing else changes.

create table if not exists orchestrator_budget_approvals (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  plan_id text not null references orchestrator_plans (id) on delete cascade,
  actor_id text not null check (length(actor_id) between 1 and 200),
  previous_budget_usd numeric not null check (previous_budget_usd >= 0),
  approved_budget_usd numeric not null check (approved_budget_usd > 0),
  reason text not null default '' check (length(reason) <= 500),
  created_at timestamptz not null default now()
);

create index if not exists orchestrator_budget_approvals_plan on orchestrator_budget_approvals (organization_id, plan_id, created_at desc);
