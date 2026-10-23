-- The orchestrator's policy for a workspace (owner direction 2026-10-23): which model families are switched off, and the overrun tolerance
-- on budgets. One row per workspace. The policy is a JSON object; the engine validates it on every read and write and fills any missing
-- key with its initial value, so an adjustment is a row update, never a code change. Additive: the table is new and nothing else changes.

create table if not exists orchestrator_policies (
  organization_id text primary key references organizations (id) on delete cascade,
  policy jsonb not null default '{}'::jsonb check (jsonb_typeof(policy) = 'object'),
  updated_by text not null check (length(updated_by) between 1 and 200),
  updated_at timestamptz not null default now()
);
