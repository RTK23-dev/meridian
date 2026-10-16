-- Contract v6: an actual cost is the provider's verified bill, or 0 when the provider confirmed the call created no job. It is never an
-- estimate. Each ledger entry says which through its settlement. Estimate actuals written before this migration are unknown again
-- (null), so they are settled from a bill or a confirmation, and no estimate is left reading as an actual.
alter table engine_ledger add column if not exists settlement text;
update engine_ledger set settlement = 'billed' where actual_usd is not null and actual_is_estimate is not true;
update engine_ledger set actual_usd = null where actual_is_estimate is true;
alter table engine_ledger drop constraint if exists engine_ledger_estimate_flag_check;
alter table engine_ledger drop column if exists actual_is_estimate;
alter table engine_ledger add constraint engine_ledger_settlement_check check (settlement is null or settlement in ('billed', 'confirmed_absent'));
alter table engine_ledger add constraint engine_ledger_actual_settlement_check check ((actual_usd is null) = (settlement is null));

-- A reservation can be exceeded: a verified bill took it above its authorized amount, so no further paid call is authorized for it.
-- Its budgets are kept, so each call is checked against the request budget and the month budget it was authorized under.
alter table engine_reservations drop constraint if exists engine_reservations_state_check;
alter table engine_reservations add constraint engine_reservations_state_check check (state in ('reserved', 'paused', 'exceeded', 'released'));
alter table engine_reservations add column if not exists request_budget_usd numeric(14, 4) check (request_budget_usd is null or request_budget_usd >= 0);
alter table engine_reservations add column if not exists month_budget_usd numeric(14, 4) check (month_budget_usd is null or month_budget_usd >= 0);

-- A Claude role call's cost is its provider bill or null; its estimate flag goes with the estimate it no longer uses.
alter table engine_role_calls drop column if exists actual_is_estimate;
