-- Durable idempotency state for Hypit video uploads; only confirmed provider ids
-- are copied into provider_objects and audit_log.
create table if not exists meta_video_uploads (
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  creative_id text not null references creative_records (id) on delete cascade,
  idempotency_key text not null,
  upload_name text not null,
  sha256 text not null,
  byte_length bigint not null,
  status text not null check (status in ('ready', 'pending', 'confirmed')),
  external_id text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, idempotency_key)
);
