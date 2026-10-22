-- Operational telemetry for each paid engine call, kept beside its ledger entry (owner direction 2026-10-22: tokens and time per
-- task, with the real cost where the provider reports it). The ledger stays the money record. This table holds what the call
-- measured: its tokens, its latency, the provider's generation id, and the cost the response itself reported. No prompt, response
-- body or key is stored here. A null field means the value was not reported. It is never zero.
-- Additive: the tables are new and nothing else changes.

create table if not exists engine_call_telemetry (
  ledger_entry_id text primary key references engine_ledger (id) on delete cascade,
  organization_id text not null references organizations (id) on delete cascade,
  provider text not null check (length(provider) between 1 and 80),
  model text not null check (length(model) between 1 and 200),
  generation_id text check (generation_id is null or length(generation_id) between 1 and 256),
  prompt_tokens integer check (prompt_tokens is null or prompt_tokens >= 0),
  completion_tokens integer check (completion_tokens is null or completion_tokens >= 0),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  response_cost_usd numeric(14, 4) check (response_cost_usd is null or response_cost_usd >= 0),
  recorded_at timestamptz not null default now()
);

create index if not exists engine_call_telemetry_org_recorded_idx on engine_call_telemetry (organization_id, recorded_at);

-- The bill reads of held calls: how many times each held call's bill has been read, when it may next be read, and whether reading
-- has stopped. A held call is read a fixed number of times at most, spaced out (budget/reconcile-holds.ts). The ledger row is not
-- changed by this table. A row is deleted when its call settles.
create table if not exists engine_bill_reads (
  ledger_entry_id text primary key references engine_ledger (id) on delete cascade,
  organization_id text not null references organizations (id) on delete cascade,
  attempts integer not null default 0 check (attempts >= 0),
  next_read_at timestamptz,
  given_up boolean not null default false,
  last_reason text not null default '' check (length(last_reason) <= 500),
  updated_at timestamptz not null default now()
);

create index if not exists engine_bill_reads_due_idx on engine_bill_reads (organization_id, given_up, next_read_at);
