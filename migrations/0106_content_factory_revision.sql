-- A Content Factory session can start another video after the current one is delivered or has failed.
-- The first request id does not change. Later requests use the revision number. Earlier request ids stay on the session.

alter table content_factory_sessions
  add column if not exists revision integer not null default 0 check (revision >= 0),
  add column if not exists prior_request_ids text not null default '[]';
