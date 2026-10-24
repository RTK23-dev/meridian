-- Content governance (prompt 18): content pillars and a posting cadence per brand, quality rubrics with scores on delivered videos, and rights
-- records for the material a video was made from. Additive only. Scores and approvals are append-only: the application never updates or
-- deletes a score row. A rights record can be revoked (revoked_at is set), never deleted, so an approval can show which record it relied on.

create table if not exists content_pillars (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  -- The share of this brand's videos the pillar is meant to take, in percent. Null is not set (the person has not chosen a share).
  target_share numeric(5, 2) check (target_share is null or (target_share > 0 and target_share <= 100)),
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (brand_id, name)
);

create table if not exists content_cadence (
  brand_id text primary key references brands (id) on delete cascade,
  organization_id text not null references organizations (id) on delete cascade,
  videos_per_week integer not null check (videos_per_week between 1 and 14),
  updated_by text not null,
  updated_at timestamptz not null default now()
);

alter table content_factory_sessions add column if not exists pillar_id text references content_pillars (id) on delete set null;

create table if not exists quality_rubrics (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  -- A JSON array of { name, weight }: at most eight criteria, each weighted 1 to 5.
  criteria text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (brand_id, name)
);

create table if not exists quality_scores (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  session_id text not null references content_factory_sessions (id) on delete cascade,
  engine_request_id text not null,
  rubric_id text not null references quality_rubrics (id) on delete restrict,
  -- A JSON object: criterion name to a whole number from 1 to 5. Total is the weighted mean, from 1 to 5.
  scores text not null,
  total double precision not null check (total >= 1 and total <= 5),
  scored_by text not null,
  created_at timestamptz not null default now()
);

create index if not exists quality_scores_session_idx on quality_scores (organization_id, session_id, created_at);

create table if not exists rights_records (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  -- The material the record covers, the party that holds the rights, and what that party permits.
  subject text not null check (length(btrim(subject)) between 1 and 200),
  holder text not null check (length(btrim(holder)) between 1 and 200),
  permitted_use text not null check (length(btrim(permitted_use)) between 1 and 500),
  valid_until date,
  -- The stored file this record covers. A file reference of a video needs a valid record before its video can be approved.
  attachment_id text references content_factory_attachments (id) on delete set null,
  created_by text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by text
);

create index if not exists rights_records_attachment_idx on rights_records (organization_id, attachment_id);
