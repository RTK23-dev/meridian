-- Queued holds and measured costs (owner direction 2026-10-23, decisions D14 and D15). Numbered after 0116. Additive only.
--
-- 1. A queued asset counts until it settles. Each row keeps its hold: held_usd is the hold of the row in total (one hold for each paid
--    submit, so a retry adds its own), and hold_usd is the hold of one submit. A row with no recorded held_usd is unrecorded: a run refuses
--    until the poll settles it, and nothing is counted as zero. seconds is the clip's length, so a settled clip can be measured.
-- 2. orchestrator_cost_measurements keeps one reported bill per plan and cache key, with the clip's length. It is written from reported
--    actual costs only, never from an estimate, and it never sets a hold: it is the average cost per second the engine shows (D15).

alter table orchestrator_asset_jobs
  add column if not exists held_usd numeric check (held_usd is null or held_usd >= 0),
  add column if not exists hold_usd numeric check (hold_usd is null or hold_usd >= 0),
  add column if not exists seconds numeric check (seconds is null or seconds > 0);

create table if not exists orchestrator_cost_measurements (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  plan_id text not null references orchestrator_plans (id) on delete cascade,
  cache_key text not null check (length(cache_key) between 8 and 200),
  kind text not null check (kind in ('video', 'avatar')),
  seconds numeric not null check (seconds > 0),
  actual_usd numeric not null check (actual_usd >= 0),
  measured_at timestamptz not null default now(),
  unique (plan_id, cache_key)
);

create index if not exists orchestrator_cost_measurements_org on orchestrator_cost_measurements (organization_id, measured_at);
