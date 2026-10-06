-- Provider connection records and confirmed external ids.
-- No credentials and no seeded campaigns.

create table if not exists provider_connections (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  provider text not null,
  status text not null,
  account_id text not null default '',
  account_name text not null default '',
  permissions text not null default '[]',
  last_error text not null default '',
  last_success_at timestamptz,
  disconnected_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (organization_id, provider)
);

create table if not exists provider_objects (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  provider text not null,
  object_type text not null,
  idempotency_key text not null,
  external_id text not null,
  status text not null,
  external_url text not null default '',
  last_error text not null default '',
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, provider, object_type, idempotency_key)
);

create index if not exists provider_objects_brand_idx on provider_objects (brand_id, provider);
