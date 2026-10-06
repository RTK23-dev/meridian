-- Performance schedule payloads, sealed refresh tokens, and alert delivery.
-- No tokens, ads, or metrics are seeded.

alter table job_schedules add column if not exists payload text not null default '{}';

alter table provider_secrets add column if not exists sealed_refresh text not null default '';

create table if not exists delivery_targets (
  id text primary key,
  organization_id text not null unique references organizations (id) on delete cascade,
  kind text not null,
  url text not null,
  enabled boolean not null default true
);

create table if not exists delivery_attempts (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  alert_id text not null references alert_events (id) on delete cascade,
  status text not null,
  detail text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists delivery_attempts_alert_idx on delivery_attempts (alert_id, created_at desc);
