-- A receipt for a repurposed variation's video uploaded to a Meta ad account. A row is written only after Meta returned its own video id, so a
-- receipt never claims an upload that did not happen. It records the upload only: creating a post or an ad from it is not built yet, so
-- nothing here says a variation was published. A variation has one receipt per account, and a retry with the same key returns the receipt
-- it already has. A variation's measured results could count toward learning only once it has a receipt; generating a variation alone never does.
create table if not exists content_factory_repurpose_publications (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null,
  variant_id text not null references content_factory_repurpose_variants (id) on delete cascade,
  platform text not null check (platform in ('meta')),
  kind text not null check (kind in ('meta_ad_video')),
  platform_account_id text not null,
  external_id text not null,
  idempotency_key text not null,
  created_by text,
  created_at timestamptz not null default now(),
  constraint content_factory_repurpose_publications_key unique (organization_id, idempotency_key),
  constraint content_factory_repurpose_publications_account unique (variant_id, platform_account_id, kind)
);

create index if not exists content_factory_repurpose_publications_variant_idx
  on content_factory_repurpose_publications (organization_id, variant_id);
