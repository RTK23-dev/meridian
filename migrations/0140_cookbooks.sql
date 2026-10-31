-- Migration 0140: custom cookbooks (round 3, K6).
--
-- A cookbook is a versioned recipe for one kind of video (docs/planning/COOKBOOK_PRESETS_PLAN.md). Built-in cookbooks live in code. A
-- workspace's own cookbooks live here, one row per version. Rows are immutable: an edit writes the next version, a fork writes a new
-- cookbook id whose parent is recorded. brand_id is null when the cookbook is shared with the whole workspace (decision D3).
-- archived_at hides a cookbook from the library; old runs can still resolve it.

create table if not exists cookbooks (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text null references brands (id) on delete cascade,
  cookbook_id text not null,
  version integer not null check (version >= 1),
  parent_cookbook_id text null,
  parent_version integer null,
  body jsonb not null,
  content_hash text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  archived_at timestamptz null,
  unique (organization_id, cookbook_id, version)
);

create index if not exists idx_cookbooks_scope
  on cookbooks (organization_id, brand_id, cookbook_id);
