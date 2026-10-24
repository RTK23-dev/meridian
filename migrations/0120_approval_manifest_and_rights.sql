-- A decision and a score belong to one delivered manifest of a video, not only to its engine request (security review, findings 2 and 4).
-- A remake, a clip swap or a shot change re-delivers the same request with a new manifest, so an earlier approval or score does not
-- carry over to changed content. A decision also records the rights records its rights gate relied on.
-- Rows written before this migration have no manifest, so they read as not decided and not scored: the video must be decided again.
alter table content_factory_approvals add column if not exists manifest_id text;
alter table content_factory_approvals add column if not exists rights_record_ids jsonb not null default '[]'::jsonb;

alter table quality_scores add column if not exists manifest_id text;

create index if not exists quality_scores_manifest_idx on quality_scores (organization_id, session_id, engine_request_id, manifest_id);
