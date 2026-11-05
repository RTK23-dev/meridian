-- Migration 0153: direction runs and the scripts they write (docs/direction/INTEGRATION.md, step 2).
--
-- A person, or an agent through the same server functions, asks for script options for a draft (a Content Factory session), revises one
-- with a note, and chooses one. A run is a queued job (direction.write or direction.revise) that the worker runs once: it spends from the
-- workspace's budget through the generation path, so it is never retried by itself. The run keeps its record (framework 12.4): the request
-- as it was built, the concepts and why the others were dropped, the ranking and its reliability, every call and its cost. Each script
-- keeps every draft with its findings and its swipe test. A revision is a new script whose parent is the script it revises. A chosen
-- script's lines are posted to the draft as script lines; posted_message_ids names them, so choosing another replaces them and the
-- direction brief leaves its notes out. Additive: no existing row changes.

create table if not exists direction_runs (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text references brands (id) on delete set null,
  session_id text not null,
  kind text not null check (kind in ('write', 'revise')),
  status text not null check (status in ('queued', 'running', 'ready', 'needs_person', 'failed')),
  job_id text,
  -- What was asked: the number of options, the video's job, the niche, the length, the language; for a revision, the script and the note.
  ask text not null default '{}',
  -- The direction request as built when the run was asked for. Its brief, sources and brand fields are untrusted material, kept as data.
  request text not null,
  -- The run's record: the deck, the obvious ideas, the concepts and the dropped ones, the ranking, its reliability and every call.
  record text not null default '{}',
  reasons text not null default '[]',
  notes text not null default '[]',
  codex_version text not null,
  prompts text not null default '{}',
  calls integer not null default 0 check (calls >= 0),
  call_limit integer not null check (call_limit > 0),
  -- The sum of the costs the provider reported. Null until the run ends, and null when any call's cost is unknown.
  cost_usd numeric(12, 6),
  created_by text not null,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint direction_runs_org_id_key unique (organization_id, id),
  constraint direction_runs_session_fkey foreign key (organization_id, session_id)
    references content_factory_sessions (organization_id, id) on delete cascade
);

create index if not exists direction_runs_session_idx on direction_runs (organization_id, session_id, created_at desc);

create table if not exists direction_scripts (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  session_id text not null,
  run_id text not null,
  -- The script this one revises, or null for a first version.
  parent_id text,
  version integer not null default 1 check (version >= 1),
  -- The option's place in its run: 1 is the best-ranked concept.
  rank integer check (rank is null or rank >= 1),
  concept_id text not null,
  concept text not null,
  -- Every draft of this version, in order: the script, its findings report, the swipe test and its Lean-In score. The last is the script.
  attempts text not null,
  ships boolean not null,
  blocked boolean not null,
  state text not null default 'option' check (state in ('option', 'chosen')),
  posted_message_ids text not null default '[]',
  created_at timestamptz not null default now(),
  chosen_at timestamptz,
  chosen_by text,
  constraint direction_scripts_org_id_key unique (organization_id, id),
  constraint direction_scripts_run_fkey foreign key (organization_id, run_id)
    references direction_runs (organization_id, id) on delete cascade,
  constraint direction_scripts_session_fkey foreign key (organization_id, session_id)
    references content_factory_sessions (organization_id, id) on delete cascade,
  constraint direction_scripts_parent_fkey foreign key (organization_id, parent_id)
    references direction_scripts (organization_id, id) on delete cascade
);

create index if not exists direction_scripts_session_idx on direction_scripts (organization_id, session_id, created_at desc);
-- A draft has at most one chosen script.
create unique index if not exists direction_scripts_one_chosen on direction_scripts (organization_id, session_id) where state = 'chosen';

-- Two model seats for direction (AGENTS.md rule 5): a second script writer of another model family, and the judge (the viewer panel and
-- the swipe test). Each is an explicit choice from the live catalogue, or Auto: the workspace's model for copy and scripts.
alter table generation_task_models drop constraint if exists generation_task_models_task_check;
alter table generation_task_models add constraint generation_task_models_task_check
  check (task in ('copy', 'research_analysis', 'brain_suggest', 'vision', 'direction_writer', 'direction_judge'));
