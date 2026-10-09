-- 0031: Durable Budget Ledger & Discovery Frontier
-- Implements P0-4 (Atomic Budget Reservation Ledger) and P1-7/8 (Durable Discovery Frontier & Leases)

-- 1. Budget Accounts Table (Integer micro-units: 1 USD = 1,000,000 micros)
create table if not exists budget_accounts (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  brand_id text not null references brands(id) on delete cascade,
  max_spend_micros bigint not null default 100000000, -- default $100 cap
  spent_micros bigint not null default 0,
  reserved_micros bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_budget_account_tenant unique (organization_id, brand_id),
  constraint chk_budget_positive check (spent_micros >= 0 and reserved_micros >= 0 and max_spend_micros >= 0)
);

create index if not exists idx_budget_accounts_tenant
  on budget_accounts (organization_id, brand_id);

-- 2. Budget Reservations Table
create table if not exists budget_reservations (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  brand_id text not null references brands(id) on delete cascade,
  account_id text not null references budget_accounts(id) on delete cascade,
  creative_plan_id text,
  production_job_id text,
  amount_micros bigint not null check (amount_micros > 0),
  status text not null default 'RESERVED' check (status in ('RESERVED', 'PARTIALLY_USED', 'RELEASED', 'RECONCILED', 'FAILED', 'EXPIRED')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  released_at timestamptz,
  reconciled_at timestamptz
);

create index if not exists idx_budget_reservations_status
  on budget_reservations (account_id, status);

-- 3. Budget Ledger Entries (Double-entry transaction audit log)
create table if not exists budget_ledger_entries (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  brand_id text not null references brands(id) on delete cascade,
  account_id text not null references budget_accounts(id) on delete cascade,
  reservation_id text references budget_reservations(id) on delete set null,
  entry_type text not null check (entry_type in ('RESERVATION_CREATED', 'RESERVATION_RECONCILED', 'RESERVATION_RELEASED', 'CAP_ADJUSTED')),
  delta_spent_micros bigint not null default 0,
  delta_reserved_micros bigint not null default 0,
  balance_spent_micros bigint not null,
  balance_reserved_micros bigint not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_budget_ledger_account
  on budget_ledger_entries (account_id, created_at desc);

-- 4. Discovery Frontier Table (Durable restart-safe frontier with worker leases)
create table if not exists discovery_frontier (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  brand_id text not null references brands(id) on delete cascade,
  run_id text not null references discovery_runs(id) on delete cascade,
  url text not null,
  canonical_url text,
  depth integer not null default 0,
  parent_url text,
  status text not null default 'PENDING' check (status in ('PENDING', 'LEASED', 'PROCESSING', 'COMPLETED', 'FAILED', 'RETRY', 'BLOCKED')),
  priority integer not null default 0,
  attempts integer not null default 0,
  lease_owner text,
  lease_expires_at timestamptz,
  discovered_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  next_attempt_at timestamptz,
  last_error text
);

create index if not exists idx_discovery_frontier_run_status
  on discovery_frontier (run_id, status, priority desc);

create index if not exists idx_discovery_frontier_lease
  on discovery_frontier (status, lease_expires_at);

-- 5. Add 'rejected' to creative_plans status if table exists
alter table if exists creative_plans
  drop constraint if exists creative_plans_status_check;

alter table if exists creative_plans
  add constraint creative_plans_status_check
  check (status in ('draft', 'awaiting_approval', 'ready_for_approval', 'approved', 'executing', 'completed', 'failed', 'cancelled', 'abstained', 'rejected', 'partially_completed'));
