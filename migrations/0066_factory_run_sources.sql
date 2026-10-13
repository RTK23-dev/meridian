-- Factory Gather (NORTH_STAR section 5, step 1). The discover stage records one state per source for each run: ok, not_connected,
-- or failed with the error. A source with no key is not_connected, and the run continues with what it has. Items a source gathers
-- go to the existing evidence tables (research_ads, discovered_items, discovered_page_evidence and sources), not here.
--
-- items counts the items this run stored from the source. A source that did not run stores none, so it is 0.

create table if not exists factory_run_sources (
  run_id text not null references factory_runs (id) on delete cascade,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  source text not null,
  state text not null check (state in ('ok', 'not_connected', 'failed')),
  reason text not null default '',
  items integer not null default 0 check (items >= 0),
  created_at timestamptz not null default now(),
  primary key (run_id, source)
);

create index if not exists factory_run_sources_brand_idx
  on factory_run_sources (organization_id, brand_id, created_at desc);
