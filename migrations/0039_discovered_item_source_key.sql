-- The sources key each discovered item observed (see discovery/source-identity.ts). It links an item to
-- its source row, so a source can list every run and item that observed it.
--
-- Items discovered before this migration have a null key. Provenance lookups match exact keys only, so
-- those rows are not attributed to a source.

alter table discovered_items add column if not exists source_key text;

create index if not exists discovered_items_source_key_idx
  on discovered_items (organization_id, brand_id, source_key);
