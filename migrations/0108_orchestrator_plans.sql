-- Orchestrator (owner direction 2026-10-20; orchestrator-plan@1). Numbered after 0107.
--
-- 1. A Claude role call may be the orchestrator's plan: engine_role_calls.role is checked against every role CLAUDE_ROLES names
--    (src/engine/contracts/ledger.ts). The list here must match that list; migration-0081.test.ts reads both.
-- 2. A plan is stored per organization. A plan is a draft until its orchestrator model has written it and the engine has checked it.
--    Its events are the run's record, in order: one row for each state a step went through.
--
-- The role constraint is widened, never narrowed, so no stored row can break. The two tables are new.

alter table engine_role_calls drop constraint if exists engine_role_calls_role_check;
alter table engine_role_calls
  add constraint engine_role_calls_role_check check (role in (
    'segmenter', 'genome', 'request_classifier', 'planner', 'director_check', 'tightener', 'critic_take',
    'critic_final', 'prompt_fixer', 'variant_writer', 'frame_reader', 'model_chooser', 'scriptwriter', 'orchestrator_plan'
  ));

create table if not exists orchestrator_plans (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  title text not null check (length(title) between 1 and 120),
  brief jsonb not null,
  orchestrator_model text not null check (length(orchestrator_model) between 3 and 200),
  budget_usd numeric not null check (budget_usd > 0),
  status text not null check (status in ('draft', 'planning', 'refused', 'ready', 'running', 'paused', 'incomplete', 'complete')),
  plan jsonb,
  reasons jsonb not null default '[]'::jsonb,
  catalog_read_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists orchestrator_plans_org_created on orchestrator_plans (organization_id, created_at desc);

create table if not exists orchestrator_plan_events (
  plan_id text not null references orchestrator_plans (id) on delete cascade,
  seq integer not null check (seq >= 1),
  node_id text not null check (length(node_id) between 1 and 40),
  state text not null check (state in ('planned', 'running', 'done', 'cache_hit', 'skipped', 'failed', 'not_connected', 'paused')),
  output_hash text,
  cost_usd numeric check (cost_usd is null or cost_usd >= 0),
  reason text,
  at timestamptz not null default now(),
  primary key (plan_id, seq)
);

-- The outputs of a plan's steps, by cache key (orchestrator/dirty.ts). A re-run of an edited plan reuses the outputs of the steps the edit
-- did not touch; only their keys change when they are touched. A stored output is a hash, never the media itself.
create table if not exists orchestrator_step_outputs (
  plan_id text not null references orchestrator_plans (id) on delete cascade,
  cache_key text not null check (length(cache_key) between 8 and 200),
  output_hash text not null,
  cost_usd numeric check (cost_usd is null or cost_usd >= 0),
  stored_at timestamptz not null default now(),
  primary key (plan_id, cache_key)
);
