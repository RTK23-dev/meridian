-- Content Factory v2: the JEV grade beside the observed signal (NORTH_STAR section 8, item 4), the picks the Pick stage stores
-- (item 5), and the attribute each variant tests (item 5).
--
-- The grade columns sit on ad_timelines, which already carries organization_id and brand_id, so they inherit that tenancy. The
-- observed signal stays in winner_score; the jev_* columns hold the engine's grade next to it and are never blended into it.
-- Every column added here is nullable or has a default, so rows written before this migration stay valid. A row with
-- jev_status null was never graded by an engine.

alter table ad_timelines
  add column if not exists jev_status text check (jev_status in ('engine', 'observed_only')),
  add column if not exists jev_action text check (jev_action in ('AUTO_APPROVE', 'HUMAN_REVIEW', 'REJECT')),
  add column if not exists jev_reason text not null default '',
  add column if not exists jev_engine_id text,
  add column if not exists jev_model text,
  add column if not exists jev_question_versions text not null default '[]',
  add column if not exists jev_policy_version text not null default '',
  add column if not exists jev_gate_record_id text references decision_gate_records (id) on delete set null,
  add column if not exists jev_votes text not null default '[]',
  add column if not exists graded_by_run_id text;

-- The concepts a run picks to make next, from the graded ads. A pick is one concept, with the ad whose storyboard it uses.
create table if not exists factory_picks (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  run_id text not null references factory_runs (id) on delete cascade,
  concept text not null,
  research_ad_id text not null default '',
  score double precision not null,
  method text not null check (method in ('thompson')),
  created_at timestamptz not null default now()
);

create index if not exists factory_picks_run_idx on factory_picks (organization_id, brand_id, run_id, score desc);

-- A template is the storyboard of one pick, and its plan is the CreativePlan for that pick's control, as JSON with the control's
-- attributes. Empty when the plan was refused, for example because no engine decision backs it.
alter table factory_templates
  add column if not exists plan text not null default '';

-- Each variant records the one attribute it changes against its control: control, hook, angle, format, proof or cta. The
-- attribute columns hold the values the variant carries. A row from before this migration has no attribute, so it is ''.
alter table factory_variants
  add column if not exists tests_attribute text not null default ''
    check (tests_attribute in ('', 'control', 'hook', 'angle', 'format', 'proof', 'cta')),
  add column if not exists angle text not null default '',
  add column if not exists format text not null default '',
  add column if not exists proof text not null default '';
