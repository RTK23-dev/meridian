-- Phase 2 of the 2026-10-22 plan: a video or avatar step that the asset provider accepts but has not finished is queued, and its poll is
-- durable. The step's state widens to include queued, and each accepted submit is kept here until the poller settles it. Widened, never
-- narrowed, so no stored row can break.

alter table orchestrator_plan_events drop constraint if exists orchestrator_plan_events_state_check;
alter table orchestrator_plan_events
  add constraint orchestrator_plan_events_state_check
  check (state in ('planned', 'running', 'done', 'cache_hit', 'skipped', 'failed', 'not_connected', 'paused', 'queued'));

create table if not exists orchestrator_asset_jobs (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  plan_id text not null references orchestrator_plans (id) on delete cascade,
  request_id text not null,
  reservation_id text not null,
  step_id text not null check (length(step_id) between 1 and 40),
  cache_key text not null,
  kind text not null check (kind in ('visual', 'voice', 'video', 'avatar')),
  input jsonb not null,
  job jsonb not null,
  status text not null default 'waiting' check (status in ('waiting', 'done', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  next_poll_at timestamptz not null default now(),
  result text not null default '' check (length(result) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists orchestrator_asset_jobs_due on orchestrator_asset_jobs (status, next_poll_at);
create index if not exists orchestrator_asset_jobs_plan on orchestrator_asset_jobs (organization_id, plan_id, cache_key);
