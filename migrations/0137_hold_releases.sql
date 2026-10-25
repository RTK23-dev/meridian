-- An administrator's release of an uncertain budget hold: who released it, when, and why. A hold is released once. Its model run moves
-- from 'uncertain' to 'released' in the same transaction that writes this row, and a released hold no longer counts against the month.
-- Forward only: no existing row changes shape.
create table if not exists generation_hold_releases (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  model_run_id text not null references model_runs (id) on delete cascade,
  actor_id text not null,
  reason text not null,
  released_at timestamptz not null default now()
);

create index if not exists generation_hold_releases_run_idx on generation_hold_releases (model_run_id);
