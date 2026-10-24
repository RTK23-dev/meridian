-- A repurpose of a delivered Content Factory video: the settings the person chose, and one row per planned variation (the child cut of the
-- master EDL). A run is unique per session, master EDL and settings, so a repeated request returns the run it already made. A variation is
-- unique per run and key, so a retry never plans or renders it twice. Its render is recorded only when the renderer returned a video. A
-- variation is claimed ('rendering') before its renderer is called, so two starts never send the same cut twice.
create table if not exists content_factory_repurpose_runs (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text,
  session_id text not null,
  engine_request_id text not null,
  master_edl_id text not null,
  settings_digest text not null,
  settings text not null,
  created_by text,
  created_at timestamptz not null default now(),
  constraint content_factory_repurpose_runs_key unique (organization_id, session_id, master_edl_id, settings_digest),
  constraint content_factory_repurpose_runs_session_fkey foreign key (organization_id, session_id)
    references content_factory_sessions (organization_id, id) on delete cascade
);

create table if not exists content_factory_repurpose_variants (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  run_id text not null references content_factory_repurpose_runs (id) on delete cascade,
  ordinal integer not null check (ordinal >= 0),
  variant_key text not null,
  treatments text not null,
  visual text not null,
  child_edl_id text not null,
  child_artifact_id text not null,
  status text not null check (status in ('planned', 'not_priced', 'not_connected', 'rendering', 'rendered', 'failed')),
  reason text not null default '',
  rendered_artifact_id text,
  updated_at timestamptz not null default now(),
  constraint content_factory_repurpose_variants_key unique (run_id, variant_key)
);
