-- Learning state, durable jobs, and composed-text assets.
-- No seeded rows. Publishing and ad-library tables are intentionally absent.

alter table learned_patterns add column if not exists state text not null default 'INFERRED';
alter table learned_patterns add column if not exists clicks integer not null default 0;
alter table learned_patterns add column if not exists conversions integer not null default 0;
alter table learned_patterns add column if not exists spend_cents integer not null default 0;
alter table learned_patterns add column if not exists revenue_cents integer not null default 0;

alter table experiments add column if not exists audience text not null default '';
alter table experiments add column if not exists platform text not null default '';
alter table experiments add column if not exists success_metric text not null default 'ctr';
alter table experiments add column if not exists expected_learning text not null default '';

create table if not exists jobs (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text references brands (id) on delete cascade,
  job_type text not null,
  idempotency_key text not null,
  status text not null check (status in ('queued', 'running', 'retry', 'succeeded', 'dead')),
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  last_error text not null default '',
  payload text not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists jobs_brand_status_idx on jobs (brand_id, status);

create table if not exists assets (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  creative_id text references creative_records (id) on delete cascade,
  version integer not null default 1,
  storage_key text not null,
  content_hash text not null,
  mime_type text not null,
  source text not null,
  status text not null check (status in ('stored', 'unavailable')),
  created_at timestamptz not null default now()
);

create index if not exists assets_creative_idx on assets (creative_id, version);
