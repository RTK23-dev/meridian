-- Closable domain gaps. No seeded market, performance, or publish rows.

alter table brand_brains add column if not exists personas text not null default '';
alter table brand_brains add column if not exists colors text not null default '';
alter table brand_brains add column if not exists typography text not null default '';
alter table brand_brains add column if not exists use_organization_learning boolean not null default false;

alter table competitors add column if not exists kind text not null default 'direct'
  check (kind in ('direct', 'adjacent', 'inspirational'));

alter table performance_observations add column if not exists reach integer not null default 0;

alter table learned_patterns add column if not exists scope text not null default 'brand'
  check (scope in ('brand', 'organization', 'global'));

alter table experiments add column if not exists variant_role text not null default 'variant'
  check (variant_role in ('control', 'variant'));

alter table jobs add column if not exists run_after timestamptz not null default now();

alter table model_runs add column if not exists cost_cents integer;

alter table creative_records add column if not exists novelty text not null default '';

alter table assets add column if not exists body text not null default '';
alter table assets add column if not exists byte_size integer not null default 0;
alter table assets add column if not exists label text not null default '';

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'learned_patterns_brand_id_attribute_value_metric_key'
  ) then
    alter table learned_patterns drop constraint learned_patterns_brand_id_attribute_value_metric_key;
  end if;
end $$;

create unique index if not exists learned_patterns_scope_identity
  on learned_patterns (brand_id, attribute, value, metric, scope);

create table if not exists creative_relationships (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  creative_id text not null references creative_records (id) on delete cascade,
  relation text not null,
  value text not null,
  created_at timestamptz not null default now()
);

create index if not exists creative_relationships_brand_idx on creative_relationships (brand_id, relation);

create table if not exists notifications (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text references brands (id) on delete cascade,
  kind text not null,
  title text not null,
  body text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists notifications_brand_idx on notifications (brand_id, created_at desc);
