-- A reviewer's decision on one rendered repurposed variation. A decision names the variation's run, its key and the rendered video it was
-- made on, so a re-render (a new video) starts undecided and the earlier decisions stay in the history. Rows are written once and never
-- updated or deleted by the application. An approval records the rights records that covered its files, as an approval of a master does.
create table if not exists content_factory_repurpose_reviews (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  run_id text not null references content_factory_repurpose_runs (id) on delete cascade,
  variant_key text not null,
  rendered_artifact_id text not null,
  decision text not null check (decision in ('approved', 'rejected')),
  reason text not null default '',
  rights_record_ids text not null default '[]',
  actor_id text not null,
  created_at timestamptz not null default now()
);

create index if not exists content_factory_repurpose_reviews_variant_idx
  on content_factory_repurpose_reviews (organization_id, run_id, variant_key, created_at);
