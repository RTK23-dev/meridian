-- Discovery at volume (Factory Gather, Instagram volume) and the outlier rater's stored results (B1 and B2).
--
-- Rules this migration follows (AGENTS.md rule 1, NORTH_STAR section 6):
--  - An unknown value is NULL. The 0025 defaults of 0, 1.0, 'C' and "now()" for a post time are removed, because they wrote
--    a guess into a row. A row that was never observed keeps the column empty.
--  - Every row is organization-scoped. The rating and snapshot tables get organization_id; creator_snapshots gets it too.
--  - Apify requests are recorded before they are sent (instagram_volume_requests), so the weekly and per-run caps count
--    what was asked for, not what was stored. A cap is a hard limit.
--
-- The tables from 0025 are empty before this migration (nothing wrote them), so the backfills below touch no rows in practice.

-- 1. Organic reel candidates (0025): nullable, no guessed defaults, and the run that gathered each one.
alter table discovered_organic_reels
  alter column external_post_id drop not null,
  alter column external_post_id drop default,
  alter column posted_at drop not null,
  alter column posted_at drop default,
  alter column creator_follower_count drop not null,
  alter column creator_follower_count drop default,
  alter column creator_median_views drop not null,
  alter column creator_median_views drop default,
  alter column creator_variance drop not null,
  alter column creator_variance drop default,
  alter column is_audio_trending drop not null,
  alter column is_audio_trending drop default,
  alter column audio_reel_count drop not null,
  alter column audio_reel_count drop default,
  alter column duration_ms drop not null,
  alter column duration_ms drop default;

alter table discovered_organic_reels
  add column if not exists run_id text references factory_runs (id) on delete set null,
  add column if not exists views_metric text,
  add column if not exists creator_baseline_reason text not null default '',
  add column if not exists source_actor text not null default '';

create index if not exists discovered_organic_reels_run_idx
  on discovered_organic_reels (organization_id, run_id);

-- 2. Snapshots (0025): one row per checkpoint (0, 24 and 72 hours after discovery). Views and likes are null when the source
-- did not report them.
alter table discovered_reel_snapshots
  add column if not exists organization_id text,
  add column if not exists checkpoint_hours integer;

update discovered_reel_snapshots as s
  set organization_id = r.organization_id
  from discovered_organic_reels as r
  where r.id = s.reel_id and s.organization_id is null;

alter table discovered_reel_snapshots
  alter column organization_id set not null,
  add constraint discovered_reel_snapshots_org_fk foreign key (organization_id) references organizations (id) on delete cascade,
  add constraint discovered_reel_snapshots_checkpoint_check check (checkpoint_hours is null or checkpoint_hours in (0, 24, 72)),
  alter column hours_since_post drop not null,
  alter column hours_since_post drop default,
  alter column views_count drop not null,
  alter column views_count drop default,
  alter column likes_count drop not null,
  alter column likes_count drop default,
  alter column comments_count drop not null,
  alter column comments_count drop default,
  alter column friend_tag_comment_count drop not null,
  alter column friend_tag_comment_count drop default;

create unique index if not exists discovered_reel_snapshots_checkpoint_idx
  on discovered_reel_snapshots (reel_id, checkpoint_hours);

-- 3. Ratings (0025): the tier is S, A, B or C, or null with the reason it could not be rated. Scores are null when they
-- were not computed. intent_score stays null until friend-tag comments are observed.
alter table discovered_reel_ratings
  add column if not exists organization_id text,
  add column if not exists checkpoint_hours integer,
  add column if not exists rating_reason text not null default '',
  add column if not exists views_used bigint,
  add column if not exists creator_median_views bigint;

update discovered_reel_ratings as rt
  set organization_id = r.organization_id
  from discovered_organic_reels as r
  where r.id = rt.reel_id and rt.organization_id is null;

alter table discovered_reel_ratings
  alter column organization_id set not null,
  add constraint discovered_reel_ratings_org_fk foreign key (organization_id) references organizations (id) on delete cascade,
  add constraint discovered_reel_ratings_checkpoint_check check (checkpoint_hours is null or checkpoint_hours in (0, 24, 72)),
  add constraint discovered_reel_ratings_tier_check check (rating_tier is null or rating_tier in ('S', 'A', 'B', 'C')),
  alter column outlier_ratio drop not null,
  alter column outlier_ratio drop default,
  alter column shrunk_outlier_score drop not null,
  alter column shrunk_outlier_score drop default,
  alter column velocity_score drop not null,
  alter column velocity_score drop default,
  alter column action_score drop not null,
  alter column action_score drop default,
  alter column intent_score drop not null,
  alter column intent_score drop default,
  alter column rating_tier drop not null,
  alter column rating_tier drop default;

create index if not exists discovered_reel_ratings_latest_idx
  on discovered_reel_ratings (organization_id, reel_id, rated_at desc);

-- 4. Creators (0026 defines followers_count; creators.ts used follower_count, engagement_rate and metadata, which no migration
-- defined). Unknown follower counts are null.
alter table creators
  add column if not exists engagement_rate double precision,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

-- 5. Creator snapshots (0026): the baseline per creator. Its columns are the ones 0026 defines (followers_count, median_views,
-- median_likes, median_comments), plus the scope, the sample the median came from, and why a baseline is missing.
alter table creator_snapshots
  add column if not exists organization_id text,
  add column if not exists reel_sample_size integer,
  add column if not exists baseline_status text,
  add column if not exists baseline_reason text not null default '';

update creator_snapshots as s
  set organization_id = c.organization_id
  from creators as c
  where c.id = s.creator_id and s.organization_id is null;

alter table creator_snapshots
  alter column organization_id set not null,
  add constraint creator_snapshots_org_fk foreign key (organization_id) references organizations (id) on delete cascade,
  add constraint creator_snapshots_baseline_status_check
    check (baseline_status is null or baseline_status in ('measured', 'insufficient', 'failed'));

create index if not exists creator_snapshots_org_idx
  on creator_snapshots (organization_id, creator_id, captured_at desc);

-- 6. Apify requests. Each request is written with status 'requested' before it is sent, then settled to 'ok', 'failed' or
-- 'not_connected'. The weekly candidate cap sums requested_results, so a failed request still counts against the cap.
create table if not exists instagram_volume_requests (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  run_id text references factory_runs (id) on delete set null,
  niche text not null,
  purpose text not null check (purpose in ('candidates', 'baseline', 'snapshot')),
  actor_id text not null,
  requested_results integer not null check (requested_results >= 0),
  returned_items integer check (returned_items is null or returned_items >= 0),
  status text not null check (status in ('requested', 'ok', 'failed', 'not_connected')),
  reason text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists instagram_volume_requests_niche_idx
  on instagram_volume_requests (organization_id, niche, purpose, created_at desc);
