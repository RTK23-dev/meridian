-- Structured evidence a discovered page declares about itself (JSON-LD, Open Graph, meta).
--
-- One set per run and page, so repeated discovery keeps history instead of overwriting it.
-- source_key is the sources.external_id for this page's website source (see discovery/source-identity.ts),
-- so evidence joins to the source row for the same brand.
--
-- state is OBSERVED only. The row records what the page declares; whether the claim holds is JEV's call.

create table if not exists discovered_page_evidence (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  run_id text not null references discovery_runs (id) on delete cascade,
  source_key text not null,
  page_url text not null,
  kind text not null check (kind in ('json_ld', 'open_graph', 'meta')),
  payload jsonb not null,
  state text not null default 'OBSERVED' check (state = 'OBSERVED'),
  observed_at timestamptz not null default now(),
  unique (run_id, page_url, kind)
);

create index if not exists discovered_page_evidence_source_idx
  on discovered_page_evidence (organization_id, brand_id, source_key);
