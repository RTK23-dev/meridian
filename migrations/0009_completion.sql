-- Performance sync identity, OAuth state, webhook receipts, and in-app alerts.
-- No tokens, ads, or metrics are seeded.

alter table performance_observations alter column revenue_cents drop not null;
alter table performance_observations add column if not exists external_id text not null default '';
create unique index if not exists performance_external_idx
  on performance_observations (organization_id, external_id)
  where external_id <> '';

create table if not exists oauth_states (
  state_hash text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  provider text not null,
  expires_at timestamptz not null,
  used_at timestamptz
);

create table if not exists provider_secrets (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  provider text not null,
  sealed_token text not null,
  updated_at timestamptz not null default now(),
  unique (organization_id, provider)
);

create table if not exists webhook_events (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  provider text not null,
  event_id text not null,
  received_at timestamptz not null default now(),
  unique (provider, event_id)
);

create table if not exists alert_events (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  code text not null,
  severity text not null,
  detail text not null,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  acknowledged_at timestamptz,
  delivery_status text not null default 'NOT_CONFIGURED'
);

create unique index if not exists alert_open_idx
  on alert_events (organization_id, code)
  where acknowledged_at is null;
