-- A re-grade keeps the earlier grade. The current grade stays on ad_timelines. The grade it replaced is copied here and is not changed again.
create table if not exists ad_timeline_grades (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  research_ad_id text not null,
  fingerprint text not null,
  jev_status text,
  jev_action text,
  jev_reason text not null default '',
  jev_engine_id text,
  jev_model text,
  jev_question_versions text not null default '[]',
  jev_policy_version text not null default '',
  jev_gate_record_id text,
  graded_by_run_id text not null default '',
  recorded_at timestamptz not null default now(),
  unique (organization_id, brand_id, research_ad_id, fingerprint)
);

create index if not exists ad_timeline_grades_ad_idx
  on ad_timeline_grades (organization_id, brand_id, research_ad_id, recorded_at desc);

-- A learned win on one surface proposed as a test on the other. The proposal does not change that surface's pick weight.
create table if not exists factory_surface_proposals (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  run_id text not null,
  concept text not null,
  from_surface text not null check (from_surface in ('organic', 'paid')),
  to_surface text not null check (to_surface in ('organic', 'paid')),
  attribute text not null,
  value text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  unique (organization_id, run_id, concept, from_surface, to_surface, attribute, value)
);

create index if not exists factory_surface_proposals_run_idx
  on factory_surface_proposals (organization_id, brand_id, run_id);
