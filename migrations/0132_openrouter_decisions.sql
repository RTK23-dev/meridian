-- OpenRouter Decisions: the third decision engine (src/lib/meridian/decisions/openrouter-engine.ts).
--
-- This is a forward migration. Migrations 0046 and 0048 are unchanged. Existing rows keep their engine ('jev' or
-- 'openai-decisions'), so an existing workspace's active engine is unchanged by this migration.

-- 1. Accept the new engine id in the two places that name the engines. Widening a check never rejects an existing row.
alter table decision_engine_settings drop constraint if exists decision_engine_settings_engine_id_check;
alter table decision_engine_settings
  add constraint decision_engine_settings_engine_id_check
  check (engine_id in ('jev', 'openai-decisions', 'openrouter-decisions'));

alter table decision_gate_records drop constraint if exists decision_gate_records_engine_id_check;
alter table decision_gate_records
  add constraint decision_gate_records_engine_id_check
  check (engine_id is null or engine_id in ('jev', 'openai-decisions', 'openrouter-decisions'));

-- 2. The decision model a workspace has chosen for OpenRouter. It is kept apart from the active engine, so choosing or changing
--    the model never changes which engine decides. The model is a pinned, verified id, validated before it is written.
create table if not exists decision_engine_openrouter_config (
  organization_id text primary key references organizations (id) on delete cascade,
  model text not null check (char_length(model) between 1 and 128),
  updated_by text not null,
  updated_at timestamptz not null default now()
);

-- 3. Explicit connection checks. A check sends one real request and records its outcome here. It changes no product data and
--    no active engine. The engine is READY only while the latest passed check matches the current model and key fingerprint.
create table if not exists decision_engine_checks (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  engine_id text not null check (engine_id in ('openrouter-decisions')),
  model text not null check (char_length(model) between 1 and 128),
  key_fingerprint text not null,
  status text not null check (status in ('passed', 'failed')),
  message text not null,
  returned_model text,
  upstream_provider text,
  provider_request_id text,
  actor_id text not null,
  checked_at timestamptz not null default now()
);

create index if not exists idx_decision_engine_checks_org_engine
  on decision_engine_checks (organization_id, engine_id, checked_at desc);

-- 4. Provider identity on each decision run: the provider that served the model and its own request id, as the provider reported
--    them. Rows written before this migration have neither, and nothing is filled in for them.
alter table jev_runs add column if not exists upstream_provider text;
alter table jev_runs add column if not exists provider_request_id text;
