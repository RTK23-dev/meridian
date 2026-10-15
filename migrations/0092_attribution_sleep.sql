-- Sales attribution (B5) and sleep mode (B6). One migration for both workstreams.
-- Unknown values are null, never 0 or an invented figure. Orders store attribution fields and totals, not customer data.

-- B5: the Shopify shop each workspace sells through. A shop belongs to one workspace; the webhook is routed by its domain.
create table if not exists shopify_shops (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  shop_domain text not null unique,
  connected_by text not null default '',
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz
);

-- B5: one UTM-tagged link and one DM keyword per published reel. The utm_content and the keyword are the join keys.
create table if not exists reel_attributions (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  creative_id text not null references creative_records (id) on delete cascade,
  utm_source text not null default 'meridian',
  utm_medium text not null default 'reel',
  utm_campaign text not null,
  utm_content text not null,
  dm_keyword text not null,
  destination_url text,
  link_url text,
  created_at timestamptz not null default now(),
  unique (organization_id, creative_id),
  unique (organization_id, utm_content),
  unique (organization_id, dm_keyword)
);

create index if not exists reel_attributions_brand_idx on reel_attributions (organization_id, brand_id);

-- B5: one stored row per Shopify order, keyed by the shop and the Shopify order id. creative_id is null until a reel matches.
create table if not exists shopify_orders (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  shop_domain text not null,
  shopify_order_id text not null,
  order_name text,
  currency text,
  total_price text,
  subtotal_price text,
  total_tax text,
  total_discounts text,
  ordered_at timestamptz,
  landing_site text,
  referring_site text,
  source_name text,
  utm_content text,
  utm_campaign text,
  discount_codes text,
  note_attributes text,
  creative_id text references creative_records (id) on delete set null,
  match_rule text check (match_rule is null or match_rule in ('utm_content', 'dm_keyword')),
  received_at timestamptz not null default now(),
  unique (organization_id, shop_domain, shopify_order_id)
);

create index if not exists shopify_orders_creative_idx on shopify_orders (organization_id, creative_id);
create index if not exists shopify_orders_brand_idx on shopify_orders (organization_id, brand_id, received_at desc);

-- B6: the sleep-mode setting, one row per workspace. Off by default. The nightly job is a job_schedules row named sleep:<org>.
create table if not exists sleep_mode_settings (
  organization_id text primary key references organizations (id) on delete cascade,
  brand_id text references brands (id) on delete set null,
  enabled boolean not null default false,
  night_time text not null default '03:00' check (night_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  time_zone text not null default 'UTC',
  niche text not null default '',
  updated_by text not null default '',
  updated_at timestamptz not null default now()
);

-- B6: the morning summary, one row per night. A night key is the local date the night ran, so a night runs once.
create table if not exists sleep_mode_nights (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  night_key text not null,
  run_id text not null default '',
  status text not null check (status in ('running', 'planned', 'stopped', 'failed')),
  reason text not null default '',
  summary text not null default '',
  sources text not null default '[]',
  stages text not null default '[]',
  counts text not null default '{}',
  holdout_item_ids text not null default '[]',
  failures text not null default '[]',
  challenger text not null default '{}',
  change_budget text not null default '{}',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (organization_id, night_key)
);

create index if not exists sleep_mode_nights_brand_idx on sleep_mode_nights (organization_id, brand_id, started_at desc);

-- B6: every planned item (a factory template with a plan) gets exactly one arm, so the learning step can compare the two.
create table if not exists factory_holdouts (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  night_id text not null default '',
  run_id text not null,
  item_id text not null,
  arm text not null check (arm in ('holdout', 'treated')),
  share double precision not null,
  assigned_at timestamptz not null default now(),
  unique (organization_id, item_id)
);

create index if not exists factory_holdouts_run_idx on factory_holdouts (organization_id, run_id);
