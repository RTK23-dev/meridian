-- Content factory: job graph, timelines, DNA, caps, kill switch, yield.

alter table research_collection_runs
  add column if not exists videos_downloaded integer not null default 0,
  add column if not exists transcripts_produced integer not null default 0,
  add column if not exists snapshot_without_video integer not null default 0,
  add column if not exists yield_json text not null default '{}';

alter table learned_patterns
  add column if not exists p_beat double precision,
  add column if not exists ci_low double precision,
  add column if not exists ci_high double precision,
  add column if not exists q_value double precision;

create table if not exists factory_runs (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  niche text not null default '',
  level integer not null default 0 check (level in (0, 1, 2, 3)),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'paused', 'cancelled')),
  current_stage text not null default '',
  error text not null default '',
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists factory_runs_brand_idx on factory_runs (organization_id, brand_id, created_at desc);

create table if not exists ad_timelines (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  research_ad_id text references research_ads (id) on delete cascade,
  first_seen timestamptz not null,
  last_seen timestamptz not null,
  still_running boolean not null default true,
  days_running integer not null default 0,
  sibling_variants integer not null default 0,
  platforms text not null default '[]',
  countries text not null default '[]',
  reach_low integer,
  reach_high integer,
  winner_score double precision,
  winner_low double precision,
  winner_high double precision,
  evidence text not null default '[]',
  updated_at timestamptz not null default now()
);

create unique index if not exists ad_timelines_ad_idx
  on ad_timelines (organization_id, brand_id, research_ad_id);

create table if not exists creative_dna (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  research_ad_id text,
  schema_version text not null,
  record text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists creative_dna_ad_idx
  on creative_dna (organization_id, brand_id, research_ad_id, schema_version);

create table if not exists factory_templates (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  source_ad_id text not null default '',
  storyboard text not null,
  created_at timestamptz not null default now()
);

create table if not exists factory_variants (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  template_id text references factory_templates (id) on delete cascade,
  hook text not null default '',
  cta text not null default '',
  presenter text not null default '',
  length_ms integer not null default 0,
  gate_result text not null default 'review',
  created_at timestamptz not null default now()
);

create table if not exists factory_spend_caps (
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  daily_cents integer not null default 0,
  total_cents integer not null default 0,
  updated_by text not null,
  updated_at timestamptz not null default now(),
  primary key (organization_id, brand_id)
);

create table if not exists factory_kill_switches (
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text,
  scope text not null check (scope in ('brand', 'workspace')),
  engaged boolean not null default false,
  actor_id text not null,
  updated_at timestamptz not null default now()
);

create unique index if not exists factory_kill_workspace_idx
  on factory_kill_switches (organization_id) where brand_id is null;
create unique index if not exists factory_kill_brand_idx
  on factory_kill_switches (organization_id, brand_id) where brand_id is not null;

create table if not exists factory_costs (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  run_id text,
  stage text not null,
  cents integer not null default 0,
  seconds integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists factory_settings (
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  level integer not null default 0 check (level in (0, 1, 2, 3)),
  ceiling integer not null default 1 check (ceiling in (0, 1, 2, 3)),
  updated_by text not null,
  updated_at timestamptz not null default now(),
  primary key (organization_id, brand_id)
);
