-- Cumulative budget reservation total per CreativePlan, in integer USD micros.
-- The reservation boundary (BudgetLedgerService.reserve) locks the plan row and
-- checks plan_reserved_micros + amount <= spend_cap_usd in the same statement
-- that reserves the account budget. The counter is never decremented on release,
-- so it is a conservative total: a plan that failed after reserving cannot
-- reserve again, because a failed plan cannot be re-executed.

alter table creative_plans
  add column if not exists plan_reserved_micros bigint not null default 0 check (plan_reserved_micros >= 0);

update creative_plans p
set plan_reserved_micros = coalesce(
  (select sum(r.amount_micros) from budget_reservations r where r.creative_plan_id = p.id),
  0
);
