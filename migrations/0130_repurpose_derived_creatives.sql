-- A reviewed, rights-cleared repurposed variation is represented in the library as a derived creative (creative_records) with its own asset
-- row. The link is explicit: creative_records.repurpose_variant_id names the variation it was made from, and a partial unique index makes
-- the link happen once, so a retry returns the same creative. The asset points at the engine's stored media (the same storage object the
-- variation was rendered to), so no binary is copied.
--
-- The link does not publish anything. Organic publication has its own operation table below, with one row per variation and Page.

alter table creative_records
  add column if not exists repurpose_variant_id text references content_factory_repurpose_variants (id) on delete set null;

create unique index if not exists creative_records_repurpose_variant_uidx
  on creative_records (repurpose_variant_id)
  where repurpose_variant_id is not null;

-- One organic publish per variation and Facebook Page. A claim is written before Facebook is called, so two requests cannot both publish.
-- The state rules are enforced here: a published row names the post, and a claimed or uncertain row names the lease that holds it.
-- A lost reply leaves the row uncertain. Nothing publishes again automatically.
create table if not exists content_factory_repurpose_organic_publications (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null,
  variant_id text not null references content_factory_repurpose_variants (id) on delete cascade,
  creative_id text not null references creative_records (id) on delete cascade,
  platform text not null check (platform in ('facebook')),
  page_id text not null,
  state text not null check (state in ('claimed', 'uncertain', 'published', 'refused')),
  attempt integer not null default 1,
  lease_token text,
  lease_expires_at timestamptz,
  external_id text not null default '',
  post_url text not null default '',
  reason text not null default '',
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint content_factory_repurpose_organic_publications_key unique (organization_id, variant_id, platform, page_id),
  constraint content_factory_repurpose_organic_publications_state check (
    (state in ('claimed', 'uncertain') and lease_token is not null)
    or (state = 'published' and external_id <> '' and lease_token is null)
    or (state = 'refused' and lease_token is null and external_id = '')
  )
);
