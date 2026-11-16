-- One organic publish per creative, destination channel and account. A claim row is written BEFORE the provider is called, so two requests,
-- a retry, or a Factory re-launch cannot both post. organic_posts stays the receipt that measurement reads; this table is the guard.
--
-- States:
--   claimed    a request holds the lease and is about to call, or is calling, the provider.
--   published  the provider confirmed a post. Never sent again.
--   scheduled  the provider confirmed a scheduled post. Never sent again.
--   uncertain  the outcome is unknown (timeout, no reply, rate limit, or a lease that expired mid-attempt). The provider may have posted,
--              so nothing is sent again until a person has checked the platform and confirms.
--   failed     the provider refused with a definite error. Nothing was posted, and a new request may try again.
--   refused    reserved for a refusal Meridian made before any request. Nothing was posted, and a new request may try again.
--
-- The key is (organization_id, brand_id, creative_id, channel_id, target_id). target_id is the connected account the post goes to (the
-- Facebook Page id), so reconnecting a different Page is a different destination, while the same Page can never be posted to twice.

create table if not exists organic_publish_claims (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null,
  creative_id text not null,
  channel_id text not null,
  platform text not null,
  target_id text not null default '',
  status text not null check (status in ('claimed', 'published', 'scheduled', 'uncertain', 'failed', 'refused')),
  attempt integer not null default 1,
  lease_token text,
  lease_expires_at timestamptz,
  external_id text not null default '',
  post_url text not null default '',
  receipt_code text not null default '',
  error text not null default '',
  scheduled_for timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organic_publish_claims_key unique (organization_id, brand_id, creative_id, channel_id, target_id),
  constraint organic_publish_claims_state check (
    (status = 'claimed' and lease_token is not null)
    or (status in ('published', 'scheduled') and external_id <> '')
    or status in ('uncertain', 'failed', 'refused')
  )
);

create index if not exists organic_publish_claims_creative_idx
  on organic_publish_claims (organization_id, brand_id, creative_id, status);
