-- Migration 0020: Organic Social Publishing and Multi-Channel Distribution
-- Tracks organic posts on Instagram, Facebook, and YouTube, alongside organic telemetry observations.

create table if not exists channel_connections (
  id text primary key,
  organization_id text not null,
  brand_id text not null,
  platform text not null, -- 'instagram', 'facebook', 'youtube', 'tiktok'
  target_type text not null default 'organic_post', -- 'organic_post' or 'paid_ad'
  account_id text not null,
  account_name text not null,
  status text not null default 'connected', -- 'connected', 'disconnected', 'expired'
  credentials jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  unique (brand_id, platform, account_id)
);

create table if not exists organic_posts (
  id text primary key,
  organization_id text not null,
  brand_id text not null,
  creative_id text,
  asset_id text,
  platform text not null, -- 'instagram', 'facebook', 'youtube', 'tiktok'
  external_id text,
  post_url text,
  caption text not null default '',
  title text,
  tags text[] not null default array[]::text[],
  aspect_ratio text not null default '9:16', -- '9:16', '1:1', '16:9'
  status text not null default 'draft', -- 'draft', 'scheduled', 'publishing', 'published', 'failed'
  scheduled_for timestamp with time zone,
  published_at timestamp with time zone,
  error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists organic_observations (
  id text primary key,
  organization_id text not null,
  brand_id text not null,
  organic_post_id text not null references organic_posts(id) on delete cascade,
  creative_id text,
  platform text not null,
  views integer not null default 0,
  reach integer not null default 0,
  three_second_views integer not null default 0,
  average_watch_time_seconds numeric(8, 2) not null default 0,
  completion_rate numeric(6, 4) not null default 0,
  likes integer not null default 0,
  comments integer not null default 0,
  shares integer not null default 0,
  saves integer not null default 0,
  observed_on date not null default current_date,
  raw_metrics jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default now()
);

create index if not exists idx_channel_connections_brand on channel_connections(brand_id, platform);
create index if not exists idx_organic_posts_brand on organic_posts(brand_id, status);
create index if not exists idx_organic_posts_creative on organic_posts(creative_id);
create index if not exists idx_organic_observations_post on organic_observations(organic_post_id, observed_on);
