-- Migration 0091: theme pages (NORTH_STAR section 8, item B3) and Instagram trial reels (item B4).
--
-- A theme page is the account-level object a Factory run can target: its linked platform account, its persona, voice and style
-- kits, its posting schedule, and whether its Instagram posts start as a trial reel. Kit ids are text references to engine_kits.kit_id
-- (0077). The server checks them on save, because engine_kits is keyed by version and a kit id is not unique on its own.
--
-- Unknown stays null. A posting schedule with no time zone is refused, not given UTC, and a trial with no graduation strategy is
-- refused, not given one. The checks below hold that rule in the database as well as in the server.
--
-- organic_trial_reels holds the second step of a trial publish. The first step is the organic_posts receipt (0020), which is not
-- changed. The feed fields record what the scheduled check observed: a row is graduated only when an observation says so. Otherwise
-- it says a person must graduate the reel in the Instagram app, with the reason.

create table if not exists theme_pages (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  name text not null,
  niche text,
  platform text not null check (platform in ('instagram', 'facebook', 'youtube', 'tiktok')),
  platform_account_id text references platform_accounts (id) on delete set null,
  persona_kit_id text,
  voice_kit_id text,
  style_kit_id text,
  posting_time_zone text,
  posting_times jsonb,
  trial_first boolean not null default false,
  trial_graduation text check (trial_graduation in ('MANUAL', 'SS_PERFORMANCE')),
  status text not null default 'active' check (status in ('active', 'paused', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint theme_pages_org_id_key unique (organization_id, id),
  constraint theme_pages_name_check check (length(btrim(name)) > 0),
  constraint theme_pages_posting_times_check check (posting_times is null or jsonb_typeof(posting_times) = 'object'),
  constraint theme_pages_schedule_check check (posting_times is null or posting_time_zone is not null),
  constraint theme_pages_trial_check check (not trial_first or trial_graduation is not null)
);

create index if not exists theme_pages_brand_idx on theme_pages (organization_id, brand_id, status);

create table if not exists organic_trial_reels (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  organic_post_id text not null references organic_posts (id) on delete cascade,
  media_id text not null,
  graduation_strategy text not null check (graduation_strategy in ('MANUAL', 'SS_PERFORMANCE')),
  feed_status text not null default 'waiting' check (feed_status in ('waiting', 'manual_action_required', 'graduated')),
  feed_note text not null default '',
  feed_observed_at timestamptz,
  observed_is_shared_to_feed boolean,
  checks integer not null default 0 check (checks >= 0),
  last_checked_at timestamptz,
  last_error text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organic_trial_reels_post_key unique (organic_post_id),
  constraint organic_trial_reels_media_check check (length(btrim(media_id)) > 0),
  constraint organic_trial_reels_feed_check check (feed_status <> 'graduated' or feed_observed_at is not null)
);

create index if not exists organic_trial_reels_brand_idx on organic_trial_reels (organization_id, brand_id, feed_status);
