-- Migration 0027: Factory Pipeline Configuration & Visual Factory Line Process
--
-- Enables code-backed, customizable pipeline stages for the Content Factory:
-- - Custom stage prompts (brief generation, script writing, vision perception, JEV grading)
-- - Dynamic production parameters (number of video variants per brief, aspect ratio, duration, provider)
-- - Configurable winning concept grading levels (min score, P(beat) confidence, 3s retention floor)
-- - Preset configurations for industry workflows without relying on external automation tools

create table if not exists factory_pipeline_configs (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  preset_name text not null default 'viral_ugc',
  stages jsonb not null default '[]'::jsonb,
  prompts jsonb not null default '{}'::jsonb,
  generation_params jsonb not null default '{}'::jsonb,
  grading_thresholds jsonb not null default '{}'::jsonb,
  updated_by text not null,
  updated_at timestamptz not null default now(),
  unique (organization_id, brand_id)
);

create index if not exists idx_factory_pipeline_configs_brand
  on factory_pipeline_configs(organization_id, brand_id);
