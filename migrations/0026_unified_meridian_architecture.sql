-- 0026: Unified Meridian Architecture
-- Consolidates Universal Source Fabric, Universal Evidence Platform, Google Drive Primary Storage,
-- TypeSafe JEV native execution, and Provider-Neutral Production.

-- 1. Primary Binary Storage Metadata (Google Drive default)
create table if not exists storage_objects (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  brand_id text not null references brands(id) on delete cascade,
  provider text not null default 'google_drive', -- 'google_drive', 's3', 'filesystem'
  provider_file_id text not null,
  name text not null,
  mime_type text not null,
  size_bytes bigint not null,
  sha256 text not null,
  lifecycle text not null default 'stored', -- 'created', 'uploading', 'stored', 'processing', 'analyzed', 'approved', 'rejected', 'archived'
  folder_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider, provider_file_id),
  unique(organization_id, brand_id, name)
);

create index if not exists idx_storage_objects_tenant
  on storage_objects (organization_id, brand_id, lifecycle);

-- 2. Universal Source Fabric
create table if not exists sources (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  brand_id text not null references brands(id) on delete cascade,
  platform text not null, -- 'instagram', 'tiktok', 'youtube', 'meta_ad_library', 'website', 'search', 'upload', 'licensed', 'first_party_analytics'
  adapter_id text not null,
  external_id text,
  canonical_url text,
  name text not null,
  capabilities jsonb not null default '{}'::jsonb,
  status text not null default 'discovered', -- 'discovered', 'fetching', 'fetched', 'enriching', 'ready', 'failed', 'unavailable'
  health_status text not null default 'unknown',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id, platform, external_id)
);

create index if not exists idx_sources_tenant_platform
  on sources (organization_id, brand_id, platform);

create table if not exists source_snapshots (
  id text primary key,
  source_id text not null references sources(id) on delete cascade,
  snapshot_type text not null,
  raw_payload jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null default now()
);

create table if not exists source_artifacts (
  id text primary key,
  source_id text not null references sources(id) on delete cascade,
  storage_object_id text references storage_objects(id) on delete set null,
  type text not null, -- 'video', 'image', 'audio', 'transcript', 'document', 'page'
  canonical_url text,
  sha256 text,
  mime_type text,
  size_bytes bigint,
  discovered_at timestamptz not null default now(),
  captured_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists source_provenance (
  id text primary key,
  artifact_id text not null references source_artifacts(id) on delete cascade,
  adapter_id text not null,
  source_url text,
  external_id text,
  captured_at timestamptz not null,
  content_hash text,
  media_hash text,
  license_basis text,
  retention_policy text,
  created_at timestamptz not null default now()
);

-- 3. Creators and Creator Snapshots
create table if not exists creators (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  platform text not null default 'instagram',
  external_id text,
  handle text not null,
  display_name text,
  profile_url text,
  category text not null default 'general',
  niche text not null default 'general',
  bio text not null default '',
  followers_count bigint,
  following_count bigint,
  posts_count bigint,
  median_views bigint,
  average_views bigint,
  outlier_rate double precision,
  dna jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id, platform, handle)
);

create table if not exists creator_snapshots (
  id text primary key,
  creator_id text not null references creators(id) on delete cascade,
  followers_count bigint,
  following_count bigint,
  posts_count bigint,
  median_views bigint,
  average_views bigint,
  median_likes bigint,
  median_comments bigint,
  posting_frequency_per_week double precision,
  captured_at timestamptz not null default now()
);

create index if not exists idx_creator_snapshots_time
  on creator_snapshots (creator_id, captured_at desc);

-- 4. Universal Evidence Platform
create table if not exists evidence_bundles (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  brand_id text not null references brands(id) on delete cascade,
  source_id text references sources(id) on delete set null,
  artifact_id text references source_artifacts(id) on delete set null,
  content_type text not null, -- 'video', 'image', 'website', 'profile', 'document'
  title text,
  caption text,
  bundle jsonb not null default '{}'::jsonb,
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_evidence_bundles_brand
  on evidence_bundles (organization_id, brand_id, content_type);

create table if not exists evidence_observations (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  brand_id text not null references brands(id) on delete cascade,
  bundle_id text not null references evidence_bundles(id) on delete cascade,
  kind text not null, -- 'metadata', 'profile', 'performance', 'transcript', 'scene', 'ocr', 'audio', 'comment'
  value jsonb not null,
  state text not null default 'OBSERVED', -- 'OBSERVED', 'COMPUTED', 'INFERRED', 'LEARNED', 'VALIDATED'
  confidence double precision,
  source_ref jsonb,
  created_at timestamptz not null default now()
);

-- 5. Native TypeSafe JEV Engine
create table if not exists jev_runs (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  brand_id text not null references brands(id) on delete cascade,
  question_set text not null,
  model text not null,
  provider text not null default 'openrouter',
  input_hash text not null,
  status text not null default 'completed',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists jev_answers (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  brand_id text not null references brands(id) on delete cascade,
  run_id text not null references jev_runs(id) on delete cascade,
  record_id text not null,
  question_id text not null,
  question_version text not null,
  model text not null,
  provider text not null,
  answer jsonb,
  probability double precision,
  distribution jsonb,
  confidence double precision,
  status text not null default 'answered', -- 'answered', 'abstain_insufficient_evidence', 'abstain_uncertain', 'provider_error'
  evidence jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_jev_answers_record
  on jev_answers (record_id, question_id);

-- 6. Creative Intelligence, Patterns & Opportunities
create table if not exists creative_patterns (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  brand_id text not null references brands(id) on delete cascade,
  dimension text not null,
  slug text not null,
  definition text not null,
  sample_size integer not null default 0,
  performance_lift double precision not null default 0.0,
  confidence double precision not null default 0.0,
  transferability text not null default 'brand_transferable',
  state text not null default 'candidate_fit', -- 'seed_prior', 'candidate_fit', 'fitted', 'validated'
  freshness text not null default 'newly_emerging', -- 'newly_emerging', 'growing', 'mature', 'saturated', 'declining'
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists pattern_combinations (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  brand_id text not null references brands(id) on delete cascade,
  pattern_a text not null,
  pattern_b text not null,
  co_occurrence_count integer not null default 0,
  combined_lift double precision not null default 0.0,
  confidence double precision not null default 0.0,
  supporting_evidence jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists opportunity_hypotheses (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  brand_id text not null references brands(id) on delete cascade,
  title text not null,
  mechanism jsonb not null default '{}'::jsonb,
  supporting_evidence jsonb not null default '[]'::jsonb,
  contradicting_evidence jsonb not null default '[]'::jsonb,
  brand_fit_score double precision not null default 0.0,
  transferability_score double precision not null default 0.0,
  novelty_score double precision not null default 0.0,
  upside_score double precision not null default 0.0,
  uncertainty_score double precision not null default 0.0,
  cost_estimate_cents integer not null default 0,
  rights_risk text not null default 'low',
  freshness text not null default 'growing',
  rank_score double precision not null default 0.0,
  jev_status text not null default 'HUMAN_REVIEW', -- 'AUTO_APPROVE', 'HUMAN_REVIEW', 'REJECT'
  created_at timestamptz not null default now()
);

-- 7. Provider-Neutral Production
create table if not exists production_specs (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  brand_id text not null references brands(id) on delete cascade,
  opportunity_id text references opportunity_hypotheses(id) on delete set null,
  source_mode text not null default 'rework', -- 'generate', 'rework', 'hybrid', 'edit'
  spec jsonb not null default '{}'::jsonb,
  constraints jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists production_jobs (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  brand_id text not null references brands(id) on delete cascade,
  production_spec_id text not null references production_specs(id) on delete cascade,
  provider text not null, -- 'manual_cloud', 'hypit', 'google_veo', 'higgsfield', 'remote_render'
  provider_job_id text,
  status text not null default 'CREATED', -- 'CREATED', 'QUEUED', 'SUBMITTED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'
  cost_mode text not null default 'ZERO_SPEND',
  estimated_cost_cents integer not null default 0,
  actual_cost_cents integer,
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  error_message text,
  retry_count integer not null default 0,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists production_artifacts (
  id text primary key,
  production_job_id text not null references production_jobs(id) on delete cascade,
  storage_object_id text references storage_objects(id) on delete set null,
  media_type text not null default 'video',
  duration_ms integer,
  width integer,
  height integer,
  sha256 text not null,
  qc_status text not null default 'PENDING', -- 'PENDING', 'APPROVED', 'HUMAN_REVIEW', 'REJECTED'
  qc_feedback jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- 8. Model Parameters, Calibration & Guardrails
create table if not exists model_parameters (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  brand_id text not null references brands(id) on delete cascade,
  population text not null default 'global',
  parameter_name text not null,
  version text not null default 'v1-seed',
  state text not null default 'seed_prior', -- 'seed_prior', 'candidate_fit', 'fitted', 'validated', 'retired'
  prior_value double precision not null,
  posterior_value double precision,
  sample_size integer not null default 0,
  calibration_metrics jsonb not null default '{}'::jsonb,
  provenance_filter text not null default 'real_only',
  notes text,
  fit_date timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id, brand_id, population, parameter_name, version)
);

create table if not exists calibration_runs (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  brand_id text not null references brands(id) on delete cascade,
  model_id text not null,
  sample_size integer not null,
  brier_score double precision,
  log_loss double precision,
  calibration_curve jsonb not null default '[]'::jsonb,
  abstention_rate double precision not null default 0.0,
  run_at timestamptz not null default now()
);
