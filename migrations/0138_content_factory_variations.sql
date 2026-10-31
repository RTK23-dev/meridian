-- Video variations: a session made from a reusable source draft keeps the id of that draft and the angle it was given. Both are plain
-- records of lineage. The source draft is never changed by a variation, and no engine request exists until a person starts the batch.
alter table content_factory_sessions
  add column if not exists source_session_id text,
  add column if not exists variation_angle text check (variation_angle is null or char_length(variation_angle) between 1 and 40);

create index if not exists content_factory_sessions_source_idx on content_factory_sessions (organization_id, source_session_id)
  where source_session_id is not null;
