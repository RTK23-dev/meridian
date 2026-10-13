-- One settings model (NORTH_STAR §4). A brand stores its defaults. Each Factory run stores the effective settings it was started
-- with, so a later change to the brand defaults does not change a run that is already in progress. A run from before this
-- migration has no settings and is read from its level.
alter table brands add column if not exists run_defaults text not null default '{}';
alter table factory_runs add column if not exists settings text not null default '{}';

-- A run that waits for a person's approval is a status of its own, not a failure.
alter table factory_runs drop constraint if exists factory_runs_status_check;
alter table factory_runs add constraint factory_runs_status_check
  check (status in ('queued', 'running', 'awaiting_approval', 'succeeded', 'failed', 'paused', 'cancelled'));

-- A person's approval of one stage for one run. Manual and semi runs wait at spend and publish stages until it exists.
create table if not exists factory_approvals (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  run_id text not null references factory_runs (id) on delete cascade,
  stage text not null,
  approved_by text not null,
  approved_at timestamptz not null default now(),
  unique (run_id, stage)
);
create index if not exists factory_approvals_run_idx on factory_approvals (organization_id, brand_id, run_id);
