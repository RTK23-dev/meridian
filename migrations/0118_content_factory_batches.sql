-- A batch of videos (prompt 15): several Content Factory sessions made and started together, each its own item with its own state. A batch
-- has one budget, which is a hard limit on the spend of its items. A video belongs to at most one batch (the unique session_id), so its
-- state is never read from two places. Items keep their order by position.
create table if not exists content_factory_batches (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  title text not null,
  budget_usd numeric(14, 4) not null check (budget_usd > 0),
  created_by text not null,
  created_at timestamptz not null default now()
);

create table if not exists content_factory_batch_items (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  batch_id text not null references content_factory_batches (id) on delete cascade,
  session_id text not null references content_factory_sessions (id) on delete cascade,
  position integer not null check (position >= 0),
  created_at timestamptz not null default now(),
  unique (session_id),
  unique (batch_id, position)
);

create index if not exists content_factory_batch_items_batch_idx on content_factory_batch_items (organization_id, batch_id, position);
