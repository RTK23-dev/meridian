-- Provenance and brand-scoped dedupe for discovered items and public-page evidence.
--
-- Each stored record now names the adapter that produced it (adapter_id) and the source status the adapter reported when
-- the page or reference was fetched (source_status). Evidence also keeps a content_hash over its canonical URL, kind and
-- stored payload. A new record whose hash already exists for the same brand is not stored again; the run reports it as
-- seen before. The run id, canonical URL (page_url, canonical_url) and fetch time (observed_at, discovered_at) were already
-- columns, so they are reused rather than duplicated.
--
-- Rows written before this migration have no source_status and no content_hash, so they are not matched by the new
-- dedupe check. Their adapter is backfilled only where it is certain: page evidence and crawled items came from the
-- website adapter.

alter table discovered_items add column if not exists adapter_id text;
alter table discovered_items add column if not exists source_status text;

update discovered_items
set adapter_id = case when source in ('website', 'repeated_card_discovery') then 'website' else source end
where adapter_id is null;

alter table discovered_page_evidence add column if not exists adapter_id text;
alter table discovered_page_evidence add column if not exists content_hash text;
alter table discovered_page_evidence add column if not exists source_status text;

update discovered_page_evidence set adapter_id = 'website' where adapter_id is null;

-- Every run that observes an item is recorded here, so a source still lists each run that saw it. The first observation is
-- the stored item (seen_before = false). A later run that matched the same content records a sighting that points at the
-- stored item (seen_before = true), and no second item or evidence row is written.
create table if not exists discovered_sightings (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  run_id text not null references discovery_runs (id) on delete cascade,
  record_id text not null references discovered_items (id) on delete cascade,
  source_key text not null,
  seen_before boolean not null default false,
  observed_at timestamptz not null default now()
);

create index if not exists discovered_sightings_source_idx
  on discovered_sightings (organization_id, brand_id, source_key, observed_at);

create index if not exists discovered_items_brand_content_hash_idx
  on discovered_items (organization_id, brand_id, content_hash);

create index if not exists discovered_page_evidence_brand_content_hash_idx
  on discovered_page_evidence (organization_id, brand_id, content_hash);
