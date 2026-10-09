-- 0030: Durable Discovery Runs and Creative Plans
-- Implements P0-D (Persisted Creative Plans & Approval State) and P1-A (Durable Restart-Safe Discovery Frontier)

-- 1. Creative Plans Table
create table if not exists creative_plans (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  brand_id text not null references brands(id) on delete cascade,
  brief_id text references briefs(id) on delete set null,
  version text not null,
  status text not null default 'draft' check (status in ('draft', 'awaiting_approval', 'approved', 'executing', 'completed', 'failed', 'cancelled', 'abstained')),
  scope text not null,
  autonomy text not null,
  objective text not null,
  selected_concept_id text,
  plan_payload jsonb not null default '{}'::jsonb,
  budget_reserved_usd double precision not null default 0,
  spend_cap_usd double precision,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_creative_plans_tenant
  on creative_plans (organization_id, brand_id, status);

-- 2. Durable Discovery Runs Table
create table if not exists discovery_runs (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  brand_id text not null references brands(id) on delete cascade,
  scope text not null,
  status text not null default 'running' check (status in ('queued', 'running', 'completed', 'partial_success', 'partial', 'blocked', 'failed')),
  seeds jsonb not null default '[]'::jsonb,
  budget jsonb not null default '{}'::jsonb,
  progress jsonb not null default '{}'::jsonb,
  per_source_errors jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_discovery_runs_tenant
  on discovery_runs (organization_id, brand_id, status);

-- 3. Discovered Items Table
create table if not exists discovered_items (
  id text primary key,
  run_id text not null references discovery_runs(id) on delete cascade,
  organization_id text not null references organizations(id) on delete cascade,
  brand_id text not null references brands(id) on delete cascade,
  source text not null,
  url text not null,
  canonical_url text,
  card_type text,
  title text,
  text_content text,
  metrics jsonb not null default '{}'::jsonb,
  content_hash text not null,
  source_location text,
  discovered_at timestamptz not null default now()
);

create index if not exists idx_discovered_items_run
  on discovered_items (run_id, organization_id, brand_id);
