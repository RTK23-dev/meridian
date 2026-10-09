-- Cost estimates must remain distinguishable from provider reported actuals.
alter table budget_reservations
  add column if not exists estimated_spent_micros bigint,
  add column if not exists settled_spend_micros bigint,
  add column if not exists cost_basis text,
  add column if not exists estimator_version text;

-- Existing reconciliations predate reliable provenance. Do not relabel their
-- historical values as actual or estimated without source evidence.
update budget_reservations
set settled_spend_micros = actual_spent_micros,
    actual_spent_micros = null,
    cost_basis = 'LEGACY_UNVERIFIED'
where status = 'RECONCILED' and settled_spend_micros is null and actual_spent_micros is not null;

alter table budget_reservations
  drop constraint if exists budget_reservations_cost_basis_check;
alter table budget_reservations
  add constraint budget_reservations_cost_basis_check
  check (cost_basis is null or cost_basis in ('PROVIDER_ACTUAL', 'ESTIMATED', 'LEGACY_UNVERIFIED'));
alter table budget_reservations
  drop constraint if exists budget_reservations_cost_amount_check;
alter table budget_reservations
  add constraint budget_reservations_cost_amount_check
  check ((actual_spent_micros is null or actual_spent_micros >= 0)
    and (estimated_spent_micros is null or estimated_spent_micros >= 0)
    and (settled_spend_micros is null or settled_spend_micros >= 0));
