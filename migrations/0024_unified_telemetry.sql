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
  views                bigint,
  impressions          bigint,
  reach                bigint,
  clicks               bigint,
  engagements          bigint,
  shares               bigint,
  saves                bigint,
  conversions          bigint,
  spend_cents          bigint,
  revenue_cents        bigint,
  watch_time_seconds   bigint,
  hook_retention_3s    double precision,
  completion_rate      double precision,
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
