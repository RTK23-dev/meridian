-- Lineage from an approved JEV decision to a separate Hypit process.
-- No video bytes live in this table.

create table if not exists hypit_jobs (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  jev_decision_id text not null,
  brief_id text not null,
  provider text not null default 'hypit',
  provider_job_id text not null default '',
  status text not null,
  code text not null default '',
  error text not null default '',
  contract text not null,
  artifact text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, jev_decision_id, brief_id)
);

create index if not exists hypit_jobs_brand_idx on hypit_jobs (brand_id, created_at desc);
