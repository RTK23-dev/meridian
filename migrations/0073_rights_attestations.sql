-- Operator attestation of the licence for the music and the footage in a creative (NORTH_STAR section 2, decision B).
-- An attestation is a person's statement, under the fixed wording recorded here, that they hold the licence. The rights gate reads
-- only the active rows (revoked_at is null). A revoked row is kept with revoked_at set, so who attested and when is never lost.
-- asset_id names the creative the licence covers. Brand asset ids are accepted by the table, and no variant references one yet.
create table if not exists rights_attestations (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  asset_id text not null,
  kind text not null check (kind in ('music', 'footage')),
  attested_by text not null,
  attested_at timestamptz not null default now(),
  wording text not null,
  revoked_at timestamptz
);

-- One active attestation per asset and kind. A revoked row is not counted, so a licence can be attested again after a revoke.
create unique index if not exists rights_attestations_active_idx
  on rights_attestations (organization_id, brand_id, asset_id, kind) where revoked_at is null;

create index if not exists rights_attestations_brand_idx on rights_attestations (organization_id, brand_id);
