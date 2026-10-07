-- 0024: Unified Performance Telemetry & Closed-Loop Bayesian Flywheel
-- Stores granular multi-channel performance telemetry across organic social & paid ads,
-- enabling recency-decay weighted Bayesian prior updating and JEV cognitive feedback.

create table if not exists unified_performance_telemetry (
  id                   text primary key,
  organization_id      text not null,
  brand_id             text not null,
  publish_job_id       text,
  account_id           text,
  platform             text not null,
  source_type          text not null default 'organic', -- 'organic', 'paid', 'hybrid'
  creative_id          text not null default '',
  variant_id           text not null default '',
  external_post_id     text not null default '',
  hook_type            text not null default '',
  angle                text not null default '',
  format               text not null default '',
  views                integer not null default 0,
  impressions          integer not null default 0,
  reach                integer not null default 0,
  clicks               integer not null default 0,
  engagements          integer not null default 0,
  shares               integer not null default 0,
  saves                integer not null default 0,
  conversions          integer not null default 0,
  spend_cents          integer not null default 0,
  revenue_cents        integer not null default 0,
  watch_time_seconds   integer not null default 0,
  hook_retention_3s    double precision not null default 0,
  completion_rate      double precision not null default 0,
  decay_weight         double precision not null default 1.0,
  recorded_at          timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  metadata             jsonb not null default '{}'::jsonb
);

create index if not exists idx_telemetry_tenant
  on unified_performance_telemetry (organization_id, brand_id, platform);

create index if not exists idx_telemetry_recorded
  on unified_performance_telemetry (organization_id, brand_id, recorded_at desc);

create index if not exists idx_telemetry_creative
  on unified_performance_telemetry (organization_id, brand_id, creative_id);

create index if not exists idx_telemetry_queue
  on unified_performance_telemetry (publish_job_id);
