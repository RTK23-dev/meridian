-- 0025: Discovered Organic Reels & Strategist Intelligence
-- Supports Organic Reel discovery, empirical Bayes instant ratings,
-- the 11-dimension Angle Bible, deep contrast study reports, and creator footage packs.

create table if not exists discovered_organic_reels (
  id                         text primary key,
  organization_id            text not null,
  brand_id                   text not null,
  platform                   text not null default 'instagram',
  permalink                  text not null,
  external_post_id           text not null default '',
  creator_handle             text not null,
  creator_follower_count     bigint not null default 0,
  creator_median_views       bigint not null default 0,
  creator_variance           double precision not null default 1.0,
  niche                      text not null default 'general',
  caption                    text not null default '',
  hashtags                   text[] not null default '{}',
  audio_id                   text not null default '',
  audio_name                 text not null default '',
  is_audio_trending          boolean not null default false,
  audio_reel_count           bigint not null default 0,
  duration_ms                integer not null default 0,
  discovery_tier             text not null default 'graph_api', -- 'graph_api', 'vendor', 'cyclone_scout', 'bulk_upload'
  scout_device_id            text,
  creative_dna_id            text,
  posted_at                  timestamptz not null default now(),
  discovered_at              timestamptz not null default now(),
  created_at                 timestamptz not null default now(),
  unique(organization_id, permalink)
);

create index if not exists idx_discovered_reels_niche
  on discovered_organic_reels (organization_id, niche, posted_at desc);

create index if not exists idx_discovered_reels_creator
  on discovered_organic_reels (organization_id, creator_handle);

create table if not exists discovered_reel_snapshots (
  id                         text primary key,
  reel_id                    text not null references discovered_organic_reels(id) on delete cascade,
  hours_since_post           double precision not null default 0,
  views_count                bigint not null default 0,
  likes_count                bigint not null default 0,
  comments_count             bigint not null default 0,
  shares_count               bigint,
  saves_count                bigint,
  friend_tag_comment_count   integer not null default 0,
  captured_at                timestamptz not null default now()
);

create index if not exists idx_discovered_snapshots_reel
  on discovered_reel_snapshots (reel_id, captured_at asc);

create table if not exists discovered_reel_ratings (
  id                         text primary key,
  reel_id                    text not null references discovered_organic_reels(id) on delete cascade,
  outlier_ratio              double precision not null default 1.0,
  shrunk_outlier_score       double precision not null default 0.0,
  velocity_score             double precision not null default 0.0,
  action_score               double precision not null default 0.0,
  intent_score               double precision not null default 0.0,
  rating_tier                text not null default 'C', -- 'S', 'A', 'B', 'C'
  confidence_interval        jsonb not null default '{}'::jsonb,
  is_fitted                  boolean not null default false, -- false = prior, true = fitted
  rated_at                   timestamptz not null default now()
);

create index if not exists idx_discovered_ratings_tier
  on discovered_reel_ratings (rating_tier, shrunk_outlier_score desc);

create table if not exists angle_bible_entries (
  id                         text primary key,
  dimension_id               integer not null,
  dimension_name             text not null,
  slug                       text not null unique,
  name                       text not null,
  definition                 text not null,
  on_screen_cues             text[] not null default '{}',
  psychological_mechanism    text not null,
  applicable_niches          text[] not null default '{}',
  natural_product_entries    text[] not null default '{}',
  failure_modes              text[] not null default '{}',
  sample_reel_ids            text[] not null default '{}',
  predictive_weight          double precision not null default 1.0,
  is_fitted                  boolean not null default false,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

create table if not exists deep_study_reports (
  id                         text primary key,
  organization_id            text not null,
  brand_id                   text not null,
  reel_id                    text not null references discovered_organic_reels(id) on delete cascade,
  instant_rating_id          text references discovered_reel_ratings(id),
  dimension_evaluations      jsonb not null default '{}'::jsonb,
  second_by_second_map       jsonb not null default '[]'::jsonb,
  contrast_analysis          jsonb not null default '{}'::jsonb,
  mined_comment_lexicon      jsonb not null default '{}'::jsonb,
  formula_card               jsonb not null default '{}'::jsonb,
  counterfactual_statement   text not null default '',
  strategist_status          text not null default 'automated', -- 'automated', 'reviewed', 'approved'
  created_at                 timestamptz not null default now()
);

create index if not exists idx_deep_study_brand
  on deep_study_reports (organization_id, brand_id, created_at desc);

create table if not exists creator_footage_packs (
  id                         text primary key,
  organization_id            text not null,
  brand_id                   text not null,
  creator_name               text not null,
  creator_handle             text not null default '',
  niche                      text not null default 'general',
  license_status             text not null default 'active',
  license_expires_at         timestamptz,
  allows_derivative_recuts   boolean not null default true,
  paid_partnership_required  boolean not null default true,
  metadata                   jsonb not null default '{}'::jsonb,
  created_at                 timestamptz not null default now()
);

create table if not exists creator_pack_clips (
  id                         text primary key,
  pack_id                    text not null references creator_footage_packs(id) on delete cascade,
  organization_id            text not null,
  clip_type                  text not null, -- 'hook_to_camera', 'product_demo', 'reaction', 'b_roll', 'spoken_line'
  storage_key                text not null,
  duration_ms                integer not null,
  transcript                 text not null default '',
  ocr_text                   text not null default '',
  sound_bed_type             text not null default 'speech',
  created_at                 timestamptz not null default now()
);

create index if not exists idx_creator_clips_pack
  on creator_pack_clips (pack_id, clip_type);
