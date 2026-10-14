-- Asset router stores (Video Engine Bible 10.2, 10.4, 5.4; workstream W2). Numbered after 0078.
--
-- The router keeps four things across calls and processes: the attempt history that scores providers and feeds the breaker, the
-- circuit breaker itself, the concurrency buckets (one per provider class), and the asset cache. Each is organization-scoped
-- like every engine table: a provider's health, a bucket and a cached asset of one workspace are never read by another.
--
-- Money is numeric(14,4), as in engine_ledger. Times are integer milliseconds where the router works in milliseconds (the
-- breaker window and the attempt history), and timestamptz where a person reads them (the cache and the leases).

create table if not exists engine_provider_attempts (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  provider_id text not null,
  seq bigint generated always as identity,
  at_ms bigint not null check (at_ms >= 0),
  outcome text not null check (outcome in ('success', 'provider_failure', 'request_refused')),
  latency_ms bigint check (latency_ms is null or latency_ms >= 0),
  error_kind text,
  created_at timestamptz not null default now(),
  constraint engine_provider_attempts_org_id_key unique (organization_id, id)
);

create index if not exists engine_provider_attempts_provider_idx on engine_provider_attempts (organization_id, provider_id, at_ms);
create index if not exists engine_provider_attempts_seq_idx on engine_provider_attempts (organization_id, provider_id, seq);

create table if not exists engine_provider_breakers (
  organization_id text not null references organizations (id) on delete cascade,
  provider_id text not null,
  tripped_at_ms bigint not null check (tripped_at_ms >= 0),
  open_until_ms bigint not null check (open_until_ms >= tripped_at_ms),
  updated_at timestamptz not null default now(),
  primary key (organization_id, provider_id)
);

-- One row per bucket, locked while a slot is taken, so two workers cannot both take the last slot.
create table if not exists engine_buckets (
  organization_id text not null references organizations (id) on delete cascade,
  bucket_id text not null,
  primary key (organization_id, bucket_id)
);

-- A slot in use. It expires, so a worker that dies without releasing does not hold its bucket forever.
create table if not exists engine_bucket_leases (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  bucket_id text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint engine_bucket_leases_org_id_key unique (organization_id, id),
  foreign key (organization_id, bucket_id) references engine_buckets (organization_id, bucket_id) on delete cascade
);

create index if not exists engine_bucket_leases_bucket_idx on engine_bucket_leases (organization_id, bucket_id, expires_at);

-- The asset cache (Bible 10.4). The key is the sha256 of the asset request and the provider, so one key is one provider's output.
-- The first write wins: a stored asset is never replaced.
create table if not exists engine_asset_cache (
  organization_id text not null references organizations (id) on delete cascade,
  cache_key text not null check (cache_key ~ '^sha256:[0-9a-f]{64}$'),
  provider_id text not null,
  model_class text not null,
  uri text not null,
  cost_usd numeric(14, 4) not null check (cost_usd >= 0),
  media_type text,
  stored_at timestamptz not null default now(),
  primary key (organization_id, cache_key)
);

-- Every hit is recorded against the request that used it, with the cost it saved (Bible 14, savings are measured, not guessed).
create table if not exists engine_asset_cache_hits (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  request_id text not null,
  cache_key text not null,
  provider_id text not null,
  shot_id text not null,
  saved_usd numeric(14, 4) not null check (saved_usd >= 0),
  at timestamptz not null,
  constraint engine_asset_cache_hits_org_id_key unique (organization_id, id),
  foreign key (organization_id, request_id) references engine_requests (organization_id, id) on delete cascade
);

create index if not exists engine_asset_cache_hits_request_idx on engine_asset_cache_hits (organization_id, request_id, at);
