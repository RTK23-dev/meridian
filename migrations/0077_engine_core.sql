-- Video engine core tables (Video Engine Bible section 5.4, workstream W2). Numbered after 0076.
--
-- Tenancy: every engine table carries organization_id, Meridian's tenant column (the same column every other table uses).
-- The Bible calls the tenant workspaceId. Engine code maps workspaceId to organization_id one for one, so the two names
-- always hold the same value. Composite foreign keys keep every child row in its parent's tenant.
--
-- Storage: JSON bodies are text, as the rest of Meridian stores JSON (jobs.payload). Money is numeric(14,4), four decimals
-- as in Bible section 4. Media lives in Meridian's object store; engine_artifacts keeps its key, not an S3 URI (S3 is retired).
--
-- Immutability: engine_artifacts rows never change. A trigger refuses UPDATE. A redo writes a new row that names the old
-- one as a parent (Bible 5.2).

create table if not exists engine_requests (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text references brands (id) on delete cascade,
  format_id text not null,
  priority text not null check (priority in ('rush', 'normal', 'batch')),
  status text not null check (status in ('running', 'paused', 'rejected', 'delivered')),
  current_stage text not null default '',
  budget_reservation_id text,
  pause_reason text not null default '',
  state text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint engine_requests_org_id_key unique (organization_id, id)
);

create index if not exists engine_requests_org_status_idx on engine_requests (organization_id, status, updated_at);

create table if not exists engine_reservations (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  request_id text not null,
  mode text not null check (mode in ('observe', 'warn', 'cap')),
  state text not null check (state in ('reserved', 'paused', 'released')),
  lines text not null,
  estimate_usd numeric(14, 4) not null check (estimate_usd >= 0),
  redo_allowance_usd numeric(14, 4) not null check (redo_allowance_usd >= 0),
  reserved_usd numeric(14, 4) not null check (reserved_usd >= 0),
  paused_reason text,
  created_at timestamptz not null,
  constraint engine_reservations_org_id_key unique (organization_id, id),
  foreign key (organization_id, request_id) references engine_requests (organization_id, id) on delete cascade
);

create index if not exists engine_reservations_org_month_idx on engine_reservations (organization_id, created_at);

-- Budget reservation is set on the request after the reservation row exists (the composite key keeps it in the tenant).
alter table engine_requests drop constraint if exists engine_requests_budget_reservation_fkey;
alter table engine_requests add constraint engine_requests_budget_reservation_fkey
  foreign key (organization_id, budget_reservation_id) references engine_reservations (organization_id, id);

create table if not exists engine_artifacts (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  request_id text not null,
  type text not null check (type in (
    'production_request', 'validated_request', 'video_dna', 'voice_track', 'scene_plan', 'budget_reservation',
    'asset_spec', 'take', 'take_verdict', 'edl', 'composition', 'rendered_video', 'gate_result', 'review_result', 'manifest'
  )),
  schema text not null,
  stage text not null,
  parent_ids text not null default '[]',
  content_hash text not null check (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  body text not null,
  storage_key text,
  storage_mime text,
  storage_bytes integer check (storage_bytes is null or storage_bytes > 0),
  created_at timestamptz not null default now(),
  constraint engine_artifacts_media_check check ((storage_key is null) = (storage_mime is null) and (storage_key is null) = (storage_bytes is null)),
  foreign key (organization_id, request_id) references engine_requests (organization_id, id) on delete cascade
);

create index if not exists engine_artifacts_request_idx on engine_artifacts (organization_id, request_id, type);
create index if not exists engine_artifacts_hash_idx on engine_artifacts (organization_id, content_hash);

create or replace function engine_artifacts_refuse_update() returns trigger
language plpgsql as $$
begin
  raise exception 'engine_artifacts rows are immutable (Video Engine Bible 5.2): write a new artifact with the old one as a parent';
end;
$$;

drop trigger if exists engine_artifacts_immutable on engine_artifacts;
create trigger engine_artifacts_immutable
  before update on engine_artifacts
  for each row execute function engine_artifacts_refuse_update();

create table if not exists engine_gate_results (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  request_id text not null,
  gate text not null check (gate in ('request', 'dna', 'voice', 'plan', 'budget', 'take', 'edit', 'pre_render', 'render_integrity', 'post_render')),
  subject_id text not null,
  passed boolean not null,
  checks text not null,
  failing_shot_ids text not null default '[]',
  artifact_id text,
  created_at timestamptz not null default now(),
  foreign key (organization_id, request_id) references engine_requests (organization_id, id) on delete cascade
);

create index if not exists engine_gate_results_request_idx on engine_gate_results (organization_id, request_id, gate);

create table if not exists engine_decisions (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  request_id text not null,
  at text not null,
  chose text not null,
  alternatives text not null default '[]',
  reason text not null,
  decided_by text not null check (decided_by in ('scorer', 'director', 'human')),
  created_at timestamptz not null default now(),
  foreign key (organization_id, request_id) references engine_requests (organization_id, id) on delete cascade
);

create index if not exists engine_decisions_request_idx on engine_decisions (organization_id, request_id);

create table if not exists engine_ledger (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  request_id text not null,
  reservation_id text not null,
  stage text not null,
  provider text not null,
  model text not null,
  estimate_usd numeric(14, 4) not null check (estimate_usd >= 0),
  reserved_usd numeric(14, 4) not null check (reserved_usd >= 0),
  actual_usd numeric(14, 4) check (actual_usd is null or actual_usd >= 0),
  actual_is_estimate boolean,
  idempotency_key text not null,
  at timestamptz not null,
  constraint engine_ledger_idempotency_key unique (organization_id, idempotency_key),
  constraint engine_ledger_estimate_flag_check check (actual_is_estimate is null or actual_usd is not null),
  foreign key (organization_id, reservation_id) references engine_reservations (organization_id, id) on delete cascade,
  foreign key (organization_id, request_id) references engine_requests (organization_id, id) on delete cascade
);

create index if not exists engine_ledger_reservation_idx on engine_ledger (organization_id, reservation_id);
create index if not exists engine_ledger_month_idx on engine_ledger (organization_id, at);

create table if not exists engine_manifests (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  request_id text not null,
  variant_of text,
  body text not null,
  content_hash text not null check (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  foreign key (organization_id, request_id) references engine_requests (organization_id, id) on delete cascade
);

create index if not exists engine_manifests_request_idx on engine_manifests (organization_id, request_id);

create table if not exists engine_review_items (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  request_id text not null,
  kind text not null check (kind in ('escalation', 'dead_letter', 'sample')),
  status text not null default 'open' check (status in ('open', 'resolved')),
  subject_id text not null default '',
  reason text not null,
  detail text not null default '{}',
  resolution text not null default '',
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  foreign key (organization_id, request_id) references engine_requests (organization_id, id) on delete cascade
);

create index if not exists engine_review_items_open_idx on engine_review_items (organization_id, status, created_at);

create table if not exists engine_kits (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  kind text not null check (kind in ('style', 'persona', 'character', 'product', 'voice')),
  kit_id text not null,
  content_hash text not null check (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  body text not null,
  created_at timestamptz not null default now(),
  constraint engine_kits_version_key unique (organization_id, kind, kit_id, content_hash)
);

create table if not exists engine_cache_index (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  cache_kind text not null,
  content_hash text not null check (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  artifact_id text,
  storage_key text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  constraint engine_cache_index_key unique (organization_id, cache_kind, content_hash)
);

create table if not exists engine_events (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  request_id text not null,
  kind text not null,
  stage text not null default '',
  subject_id text not null default '',
  job_id text not null default '',
  dedupe_key text,
  body text not null default '{}',
  created_at timestamptz not null default now(),
  foreign key (organization_id, request_id) references engine_requests (organization_id, id) on delete cascade
);

-- A dedupe key is applied once per workspace. Events without a key leave it null, and nulls do not collide.
create unique index if not exists engine_events_dedupe_idx on engine_events (organization_id, dedupe_key);
create index if not exists engine_events_request_idx on engine_events (organization_id, request_id, created_at);
