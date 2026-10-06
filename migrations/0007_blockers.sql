-- Competitor candidates, process heartbeats, and calibration versions.
-- No seeded competitors, ads, or metrics.

alter table competitors drop constraint if exists competitors_status_check;
alter table competitors add constraint competitors_status_check
  check (status in ('candidate', 'confirmed', 'rejected', 'dismissed'));

alter table competitors add column if not exists confidence double precision;
alter table competitors add column if not exists evidence text not null default '';
alter table competitors add column if not exists source text not null default 'user';

create table if not exists process_heartbeats (
  name text primary key,
  beat_at timestamptz not null,
  detail text not null default ''
);

create table if not exists embedding_cache (
  organization_id text not null references organizations (id) on delete cascade,
  content_hash text not null,
  provider text not null,
  model text not null,
  kind text not null,
  dimensions integer not null,
  vector text not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, content_hash, provider, model)
);

create table if not exists calibration_proposals (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  question_id text not null,
  proposed text not null,
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected')),
  created_at timestamptz not null default now()
);

create table if not exists jev_threshold_versions (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  question_id text not null,
  version integer not null,
  thresholds text not null,
  approved_by text not null,
  created_at timestamptz not null default now()
);

create table if not exists source_connections (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text references brands (id) on delete cascade,
  source text not null,
  status text not null,
  last_error text not null default '',
  updated_at timestamptz not null default now()
);
