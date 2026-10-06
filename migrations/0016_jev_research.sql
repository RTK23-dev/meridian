-- Tenant-scoped external advertising research and provenance.

create table if not exists research_collection_runs (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  job_id text not null references jobs (id) on delete cascade,
  search_terms text not null,
  country text not null,
  status text not null check (status in ('queued', 'collecting', 'succeeded', 'NOT_CONNECTED', 'retry', 'failed')),
  collected_count integer not null default 0,
  analyzed_count integer not null default 0,
  error text not null default '',
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, job_id)
);

create index if not exists research_runs_brand_idx on research_collection_runs (organization_id, brand_id, created_at desc);

create table if not exists research_ads (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  collection_run_id text not null references research_collection_runs (id) on delete cascade,
  source text not null default 'meta_ad_library',
  external_id text not null,
  page_id text not null default '',
  advertiser text not null,
  original_url text not null,
  captured_at timestamptz not null,
  published_at timestamptz,
  copy text not null default '',
  headline text not null default '',
  description text not null default '',
  platforms text not null default '[]',
  media_type text not null default 'OTHER',
  media_status text not null default 'pending' check (media_status in ('pending', 'stored', 'unavailable', 'failed')),
  media_url text not null default '',
  media_storage_key text not null default '',
  media_mime_type text not null default '',
  media_sha256 text not null default '',
  media_bytes bigint,
  media_duration_ms integer,
  transcript_status text not null default 'pending' check (transcript_status in ('pending', 'transcribed', 'no_speech', 'NOT_CONNECTED', 'failed')),
  transcript_cache_id text,
  analysis_status text not null default 'pending' check (analysis_status in ('pending', 'analyzed', 'review', 'NOT_CONNECTED', 'failed')),
  analysis_id text,
  creative_id text references creative_records (id) on delete set null,
  source_metrics text not null default '{}',
  last_error text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, brand_id, source, external_id)
);

create index if not exists research_ads_brand_idx on research_ads (organization_id, brand_id, captured_at desc);
create index if not exists research_ads_filter_idx on research_ads (organization_id, brand_id, analysis_status, media_type);

create table if not exists research_transcript_cache (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  content_hash text not null,
  provider text not null,
  model text not null,
  status text not null check (status in ('transcribed', 'no_speech', 'failed')),
  transcript text not null default '',
  segments text not null default '[]',
  duration_ms integer,
  error text not null default '',
  created_at timestamptz not null default now(),
  unique (organization_id, brand_id, content_hash, provider, model)
);

create table if not exists research_analysis_runs (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  research_ad_id text not null references research_ads (id) on delete cascade,
  cache_key text not null,
  schema_version text not null,
  provider text not null,
  model text not null,
  prompt_version text not null,
  latency_ms integer not null default 0,
  tokens integer,
  status text not null check (status in ('analyzed', 'review', 'failed')),
  confidence double precision not null,
  review_required boolean not null,
  result text not null,
  error text not null default '',
  created_at timestamptz not null default now(),
  unique (organization_id, brand_id, research_ad_id, cache_key)
);

create index if not exists research_analysis_brand_idx on research_analysis_runs (organization_id, brand_id, created_at desc);

create table if not exists research_analysis_fields (
  analysis_id text not null references research_analysis_runs (id) on delete cascade,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  field text not null,
  value text not null,
  confidence double precision not null,
  probability double precision,
  evidence_ids text not null default '[]',
  primary key (analysis_id, field)
);

create table if not exists research_segments (
  analysis_id text not null references research_analysis_runs (id) on delete cascade,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  segment_id text not null,
  transcript text not null,
  start_ms integer,
  end_ms integer,
  role text not null,
  confidence double precision not null,
  primary key (analysis_id, segment_id)
);

create table if not exists research_patterns (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text references brands (id) on delete cascade,
  scope text not null default 'brand' check (scope in ('brand', 'organization')),
  dimension text not null,
  value text not null,
  state text not null check (state in ('OBSERVED', 'INFERRED', 'VALIDATED')),
  sample_count integer not null,
  corpus_size integer not null,
  prevalence double precision not null,
  confidence double precision not null,
  analysis_ids text not null default '[]',
  example_creative_ids text not null default '[]',
  summary text not null,
  created_at timestamptz not null default now(),
  unique (organization_id, brand_id, dimension, value)
);

create index if not exists research_patterns_brand_idx on research_patterns (organization_id, brand_id, sample_count desc);
create unique index if not exists research_patterns_organization_idx on research_patterns (organization_id, dimension, value) where scope = 'organization';

alter table opportunities add column if not exists research_sample_count integer not null default 0;
alter table opportunities add column if not exists research_state text not null default '';
alter table opportunities add column if not exists research_source_ids text not null default '[]';
alter table opportunities add column if not exists research_analysis_ids text not null default '[]';
alter table opportunities add column if not exists research_confidence double precision not null default 0;
