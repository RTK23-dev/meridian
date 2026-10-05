-- Evidence, decisions, production, and learning. No seeded market or performance rows.

create table if not exists competitors (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  name text not null,
  website text not null default '',
  notes text not null default '',
  status text not null default 'confirmed' check (status in ('confirmed', 'dismissed')),
  created_by text not null,
  created_at timestamptz not null default now()
);

create index if not exists competitors_brand_idx on competitors (brand_id);

create table if not exists source_documents (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  url text not null,
  status text not null check (status in ('stored', 'failed')),
  error text not null default '',
  excerpt text not null default '',
  created_by text not null,
  created_at timestamptz not null default now()
);

create index if not exists source_documents_brand_idx on source_documents (brand_id, created_at desc);

create table if not exists brain_suggestions (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  document_id text references source_documents (id) on delete set null,
  field_key text not null,
  proposed_value text not null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'dismissed')),
  provider text not null default '',
  model text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists opportunities (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  hypothesis_id text not null,
  label text not null,
  category text not null,
  angle text not null,
  hook_type text not null,
  audience text not null default '',
  format text not null,
  proof_type text not null default '',
  product_id text references products (id) on delete set null,
  product_name text not null default '',
  market_signal double precision not null,
  novelty_score double precision not null,
  brand_fit_score double precision not null,
  reproducibility_score double precision not null,
  risk_score double precision not null,
  saturation_score double precision not null,
  historical_score double precision not null,
  expected_value double precision not null,
  raw_score double precision not null,
  confidence double precision not null,
  reason text not null,
  evidence text not null,
  evidence_basis text not null,
  supporting_ids text not null default '[]',
  status text not null default 'open' check (status in ('open', 'accepted', 'dismissed', 'briefed', 'rejected')),
  decision_id text,
  created_at timestamptz not null default now()
);

create index if not exists opportunities_brand_idx on opportunities (brand_id, expected_value desc);

create table if not exists briefs (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  opportunity_id text references opportunities (id) on delete set null,
  title text not null,
  audience text not null default '',
  angle text not null,
  hook text not null,
  message text not null default '',
  offer text not null default '',
  cta text not null default '',
  format text not null,
  proof_type text not null default '',
  constraints text not null default '',
  context_pack text not null,
  workflow text not null,
  why text not null,
  learning_notes text not null default '[]',
  failure_notes text not null default '[]',
  status text not null default 'ready' check (status in ('ready', 'rejected', 'used')),
  decision_id text,
  created_by text not null,
  created_at timestamptz not null default now()
);

create table if not exists creative_records (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  competitor_id text references competitors (id) on delete set null,
  origin text not null check (origin in ('competitor', 'own', 'generated', 'uploaded')),
  source_url text not null default '',
  source_identifier text not null default '',
  title text not null default '',
  raw_text text not null default '',
  product_name text not null default '',
  audience text not null default '',
  problem text not null default '',
  desire text not null default '',
  hook text not null default '',
  hook_type text not null default '',
  angle text not null default '',
  message text not null default '',
  offer text not null default '',
  cta text not null default '',
  format text not null default '',
  platform text not null default '',
  visual_style text not null default '',
  creator_style text not null default '',
  narrative text not null default '',
  proof_type text not null default '',
  emotion text not null default '',
  claim text not null default '',
  template_key text not null default '',
  workflow text not null default '{}',
  asset_url text not null default '',
  opportunity_id text references opportunities (id) on delete set null,
  brief_id text references briefs (id) on delete set null,
  status text not null default 'observed' check (status in (
    'observed', 'briefed', 'generated', 'in_review', 'approved', 'rejected', 'testing', 'learned'
  )),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists creative_source_identity
  on creative_records (brand_id, source_identifier)
  where source_identifier <> '';

create index if not exists creative_brand_idx on creative_records (brand_id, created_at desc);

create table if not exists jev_decisions (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text references brands (id) on delete set null,
  correlation_id text not null,
  question_id text not null,
  question_version text not null,
  subject_type text not null,
  subject_id text not null,
  input text not null,
  evidence text not null,
  probability double precision not null,
  confidence double precision not null,
  thresholds text not null,
  decision text not null check (decision in ('AUTO_APPROVE', 'HUMAN_REVIEW', 'REJECT')),
  reasons text not null,
  provider text not null default '',
  model text not null default '',
  model_response text not null default '',
  reviewer_id text,
  reviewer_decision text,
  reviewer_note text not null default '',
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists jev_brand_idx on jev_decisions (brand_id, created_at desc);

create table if not exists reviews (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  decision_id text not null references jev_decisions (id) on delete cascade,
  creative_id text,
  opportunity_id text,
  subject_label text not null default '',
  status text not null default 'open' check (status in ('open', 'approved', 'rejected')),
  created_at timestamptz not null default now()
);

create index if not exists reviews_brand_idx on reviews (brand_id, status);

create table if not exists rejections (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  creative_id text,
  decision_id text,
  reason_code text not null,
  note text not null default '',
  rejected_by text not null,
  created_at timestamptz not null default now()
);

create table if not exists prompt_versions (
  id text primary key,
  prompt_id text not null,
  version text not null,
  purpose text not null,
  model text not null,
  temperature double precision not null,
  status text not null,
  input_schema text not null,
  output_schema text not null,
  created_at timestamptz not null default now(),
  unique (prompt_id, version)
);

create table if not exists model_runs (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text,
  correlation_id text not null,
  operation text not null,
  provider text not null,
  model text not null,
  prompt_id text not null,
  prompt_version text not null,
  input_ref text not null default '',
  output text not null default '',
  latency_ms integer not null default 0,
  tokens integer,
  status text not null,
  error text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists model_runs_brand_idx on model_runs (brand_id, created_at desc);

create table if not exists generation_jobs (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  brief_id text not null,
  correlation_id text not null,
  provider text not null,
  model text not null,
  prompt_id text not null,
  prompt_version text not null,
  status text not null,
  error text not null default '',
  output text not null default '',
  creative_id text,
  created_by text not null,
  created_at timestamptz not null default now()
);

create table if not exists experiments (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  creative_id text not null references creative_records (id) on delete cascade,
  hypothesis text not null,
  status text not null default 'running' check (status in ('draft', 'running', 'completed', 'cancelled')),
  created_by text not null,
  created_at timestamptz not null default now()
);

create table if not exists performance_observations (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  creative_id text not null references creative_records (id) on delete cascade,
  experiment_id text references experiments (id) on delete set null,
  platform text not null default '',
  impressions integer not null,
  clicks integer not null,
  conversions integer not null,
  spend_cents integer not null,
  revenue_cents integer not null,
  observed_on date not null,
  source text not null default 'manual',
  created_by text not null,
  created_at timestamptz not null default now()
);

create index if not exists performance_brand_idx on performance_observations (brand_id, observed_on desc);

create table if not exists learned_patterns (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  attribute text not null,
  value text not null,
  metric text not null,
  lift double precision not null,
  sample_size integer not null,
  baseline double precision not null,
  observed double precision not null,
  impressions integer not null,
  summary text not null,
  created_at timestamptz not null default now(),
  unique (brand_id, attribute, value, metric)
);
