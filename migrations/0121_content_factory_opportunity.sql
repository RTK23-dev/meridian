-- The opportunity a Content Factory session was made from: the idea whose brief the session carries. Null for a session made from nothing.
-- It is provenance, so there is no foreign key: a refresh of the opportunity list replaces the open ideas, and a session keeps the id it was
-- made from. The session service checks the id belongs to its workspace and brand when it is made.
alter table content_factory_sessions add column if not exists opportunity_id text;
