-- Durable jobs, stored objects, vectors, and market provenance.
-- No seeded ads, metrics, or publish receipts.

alter table jobs add column if not exists priority integer not null default 100;
alter table jobs add column if not exists lease_until timestamptz;
alter table jobs add column if not exists heartbeat_at timestamptz;
alter table jobs add column if not exists result text not null default '';
alter table jobs add column if not exists logs text not null default '[]';
alter table jobs add column if not exists cancel_requested boolean not null default false;
alter table jobs add column if not exists depends_on text not null default '';

alter table jobs drop constraint if exists jobs_status_check;
alter table jobs add constraint jobs_status_check
  check (status in ('queued', 'running', 'retry', 'succeeded', 'dead', 'cancelled'));

create unique index if not exists jobs_idempotency_idx on jobs (organization_id, idempotency_key);

create table if not exists job_schedules (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text references brands (id) on delete cascade,
  job_type text not null,
  every_seconds integer not null check (every_seconds >= 30),
  next_run timestamptz not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

alter table brand_brains add column if not exists mission text not null default '';
alter table brand_brains add column if not exists imagery_rules text not null default '';
alter table brand_brains add column if not exists forbidden_imagery text not null default '';
alter table brand_brains add column if not exists required_claims text not null default '';
alter table brand_brains add column if not exists proof_points text not null default '';
alter table brand_brains add column if not exists offers text not null default '';
alter table brand_brains add column if not exists objectives text not null default '';

alter table assets add column if not exists lifecycle text not null default 'stored';
alter table assets add column if not exists checksum text not null default '';
alter table assets add column if not exists width integer;
alter table assets add column if not exists height integer;
alter table assets add column if not exists duration_ms integer;
alter table assets add column if not exists provenance text not null default 'user_supplied';

create table if not exists asset_blobs (
  storage_key text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  body text not null,
  mime_type text not null,
  checksum text not null,
  byte_size integer not null,
  version integer not null default 1,
  lifecycle text not null,
  access_token text not null default '',
  access_expires timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists asset_blobs_brand_idx on asset_blobs (brand_id);

create table if not exists creative_embeddings (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  creative_id text not null references creative_records (id) on delete cascade,
  provider text not null,
  model text not null,
  dimensions integer not null,
  vector text not null,
  created_at timestamptz not null default now(),
  unique (creative_id, provider, model)
);

create index if not exists creative_embeddings_brand_idx on creative_embeddings (brand_id, provider);

create table if not exists raw_source_records (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  source text not null,
  external_id text not null default '',
  url text not null default '',
  collected_at timestamptz not null default now(),
  published_at timestamptz,
  advertiser text not null default '',
  platform text not null default '',
  media_type text not null default '',
  raw text not null default '{}',
  fingerprint text not null default '',
  status text not null default 'stored' check (status in ('stored', 'duplicate', 'failed')),
  error text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists raw_source_brand_idx on raw_source_records (brand_id, collected_at desc);

create table if not exists creative_clusters (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  label text not null,
  summary text not null default '',
  size integer not null,
  saturation double precision not null default 0,
  emerging boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists cluster_members (
  cluster_id text not null references creative_clusters (id) on delete cascade,
  creative_id text not null references creative_records (id) on delete cascade,
  primary key (cluster_id, creative_id)
);
