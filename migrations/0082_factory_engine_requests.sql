-- The Factory's link to the video engine (lead task I1 and I2). Numbered after 0081.
--
-- factory_engine_requests: one row per Factory video the engine makes. It names the run, the variant and the engine request, so the
-- run's spend can add the request's ledger actuals (factory/spend.ts) and a cap can pause the request's reservations. budget_usd is
-- the run's cost per master that the request was started with (ProductionRequest.constraints.budgetUsd); it is the most the request
-- can reserve, and the cap check counts what of it is not yet spent. The engine request row is the authority for the status.

create table if not exists factory_engine_requests (
  request_id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  run_id text not null references factory_runs (id) on delete cascade,
  variant_id text not null references factory_variants (id) on delete cascade,
  factory_job_id text not null,
  budget_usd numeric(14, 4) not null check (budget_usd >= 0),
  created_at timestamptz not null default now(),
  constraint factory_engine_requests_variant_key unique (variant_id),
  foreign key (organization_id, request_id) references engine_requests (organization_id, id) on delete cascade
);

create index if not exists factory_engine_requests_run_idx on factory_engine_requests (organization_id, brand_id, run_id);
