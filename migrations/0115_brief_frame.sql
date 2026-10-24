-- The brand frame of a brief (prompt 14): the constraints the brief was written under, each with its value and its source. An empty frame
-- ('{}') is a brief written before this column existed: every field reads as not set, and nothing is invented for it. Additive only.
alter table briefs add column if not exists frame text not null default '{}';
