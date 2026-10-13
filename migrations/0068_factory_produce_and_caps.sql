-- Content Factory: produce through the production router, and spend caps against metered spend (NORTH_STAR section 8, items 6
-- and 7).
--
-- factory_costs rows are written only from a provider call that reported its own cost. Each row names the provider, the
-- production job it belongs to, and its basis. No other basis exists, so a row is never an estimate. Rows written before this
-- migration are none: the fixed figures that used to fill the table were removed.
alter table factory_costs
  add column if not exists provider text not null default '',
  add column if not exists production_job_id text,
  add column if not exists basis text not null default 'provider_reported' check (basis in ('provider_reported'));

create index if not exists factory_costs_run_idx on factory_costs (organization_id, brand_id, run_id, created_at);

-- The creative each Factory variant produced for one format. A variant has at most one creative per format, and a creative
-- belongs to one variant, so the run, the variant and the creative are linked both ways. The creative itself lives in the same
-- creative_records table Studio uses, so Library and Reviews read it.
create table if not exists factory_creatives (
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  run_id text not null references factory_runs (id) on delete cascade,
  variant_id text not null references factory_variants (id) on delete cascade,
  format text not null check (format in ('image', 'video', 'carousel')),
  creative_id text not null,
  production_job_id text not null,
  provider text not null default '',
  created_at timestamptz not null default now(),
  primary key (variant_id, format),
  unique (creative_id)
);

create index if not exists factory_creatives_run_idx on factory_creatives (organization_id, brand_id, run_id);
