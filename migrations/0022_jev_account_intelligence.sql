-- 0022: JEV Account Intelligence & Multimodal Scoring
-- Adds tables for account-level portfolio analysis, per-content creative DNA,
-- and whitespace opportunity tracking.

-- Account-level profiles: aggregated rolling metrics and brand archetypes
create table if not exists jev_account_profiles (
  id               text primary key,
  organization_id  text not null,
  brand_id         text not null,
  platform         text not null,
  account_handle   text not null default '',
  post_count       integer not null default 0,
  follower_count   integer not null default 0,
  avg_engagement_rate  double precision not null default 0,
  posting_cadence_hours double precision not null default 0,
  brand_archetype  text not null default '',
  top_hooks        jsonb not null default '[]',
  saturated_angles jsonb not null default '[]',
  top_decile_traits jsonb not null default '{}',
  bottom_decile_traits jsonb not null default '{}',
  rolling_window_days integer not null default 30,
  analysis_version integer not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_jev_account_profiles_tenant
  on jev_account_profiles (organization_id, brand_id, platform);

-- Per-content multimodal analysis: creative DNA decomposition per post
create table if not exists jev_content_analyses (
  id               text primary key,
  organization_id  text not null,
  brand_id         text not null,
  account_id       text,
  post_id          text not null default '',
  media_sha256     text not null default '',
  hook_visual_score    double precision not null default 0,
  audio_energy_score   double precision not null default 0,
  speech_wpm       double precision not null default 0,
  narrative_beats  jsonb not null default '{}',
  detected_objections  jsonb not null default '[]',
  top_comments_summary text not null default '',
  visual_style     text not null default '',
  color_palette    text not null default '',
  motion_intensity double precision not null default 0,
  text_density     double precision not null default 0,
  hook_type        text not null default '',
  cta_type         text not null default '',
  engagement_views     integer not null default 0,
  engagement_likes     integer not null default 0,
  engagement_comments  integer not null default 0,
  engagement_shares    integer not null default 0,
  three_second_retention double precision not null default 0,
  completion_rate  double precision not null default 0,
  created_at       timestamptz not null default now()
);

create index if not exists idx_jev_content_analyses_tenant
  on jev_content_analyses (organization_id, brand_id);

create index if not exists idx_jev_content_analyses_account
  on jev_content_analyses (account_id);

-- Whitespace opportunities: angles/hooks competitors are underusing
create table if not exists jev_whitespace_opportunities (
  id                         text primary key,
  organization_id            text not null,
  brand_id                   text not null,
  category                   text not null default '',
  unsaturated_angle          text not null default '',
  competitor_saturation_score double precision not null default 0,
  expected_win_probability   double precision not null default 0,
  supporting_evidence        jsonb not null default '[]',
  status                     text not null default 'proposed',
  created_at                 timestamptz not null default now()
);

create index if not exists idx_jev_whitespace_tenant
  on jev_whitespace_opportunities (organization_id, brand_id, status);
