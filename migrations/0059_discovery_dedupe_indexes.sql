-- Brand-scoped dedupe, enforced by the database for discovered items and public-page evidence.
--
-- A record's identity is its content hash within one brand. Discovery already checks that hash before it inserts, and this
-- migration makes the rule hold under concurrent runs too: a second insert with the same hash is refused by the unique index,
-- and the writer treats the conflict as seen before (see discovery/item-store.ts and discovery/page-evidence.ts).
--
-- Canonical URL is deliberately not a unique key. A repeated card with no link takes its page's URL as its canonical URL, so
-- distinct cards on one page would collide, and the page item itself shares that URL. The content hash already covers the
-- canonical URL, the title and the text, so two cards are one record only when their content is the same.
--
-- Existing duplicates are removed first, keeping the earliest row for each key. A duplicate item's sightings are moved to the
-- kept item before it is deleted, so every run that observed the record is still listed under it. Evidence has no dependants.
-- Rows written before migration 0057 have no content hash in evidence; they are not part of any key and are left as they are.

-- 1. Discovered items: one row per (organization, brand, content hash).
with ranked as (
  select id,
         first_value(id) over (
           partition by organization_id, brand_id, content_hash
           order by discovered_at asc, id asc
         ) as keep_id
  from discovered_items
)
update discovered_sightings s
set record_id = ranked.keep_id
from ranked
where s.record_id = ranked.id and ranked.id <> ranked.keep_id;

with ranked as (
  select id,
         first_value(id) over (
           partition by organization_id, brand_id, content_hash
           order by discovered_at asc, id asc
         ) as keep_id
  from discovered_items
)
delete from discovered_items d
using ranked
where d.id = ranked.id and ranked.id <> ranked.keep_id;

drop index if exists discovered_items_brand_content_hash_idx;

create unique index if not exists discovered_items_brand_content_hash_uidx
  on discovered_items (organization_id, brand_id, content_hash);

-- 2. Public-page evidence: one row per (organization, brand, content hash). Rows without a hash are not keyed.
with ranked as (
  select id,
         first_value(id) over (
           partition by organization_id, brand_id, content_hash
           order by observed_at asc, id asc
         ) as keep_id
  from discovered_page_evidence
  where content_hash is not null
)
delete from discovered_page_evidence e
using ranked
where e.id = ranked.id and ranked.id <> ranked.keep_id;

drop index if exists discovered_page_evidence_brand_content_hash_idx;

create unique index if not exists discovered_page_evidence_brand_content_hash_uidx
  on discovered_page_evidence (organization_id, brand_id, content_hash);
