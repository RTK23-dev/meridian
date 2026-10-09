-- Persist actual usage so reconciliation retries can return the original result.
alter table budget_reservations
  add column if not exists actual_spent_micros bigint;

alter table budget_accounts
  add column if not exists status text not null default 'ACTIVE';

alter table budget_accounts
  drop constraint if exists budget_accounts_status_check;

alter table budget_accounts
  add constraint budget_accounts_status_check check (status in ('ACTIVE', 'EXCEEDED'));

alter table budget_ledger_entries
  drop constraint if exists budget_ledger_entries_entry_type_check;

alter table budget_ledger_entries
  add constraint budget_ledger_entries_entry_type_check
  check (entry_type in (
    'RESERVATION_CREATED',
    'RESERVATION_RECONCILED',
    'RESERVATION_OVERAGE',
    'RESERVATION_RELEASED',
    'CAP_ADJUSTED'
  ));
