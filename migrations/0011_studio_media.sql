-- Generation runs and media lineage. No seeded ads or vendor ids.

create table if not exists generation_runs (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  opportunity_id text,
  brief_id text,
  prompt_version text not null,
  image_provider text not null,
  video_provider text not null,
  status text not null,
  created_by text not null,
  created_at timestamptz not null default now()
);

create index if not exists generation_runs_brand_idx on generation_runs (brand_id, created_at desc);

alter table assets add column if not exists byte_size integer;
alter table assets add column if not exists provider text not null default '';
alter table assets add column if not exists model text not null default '';
alter table assets add column if not exists prompt_version text not null default '';
alter table assets add column if not exists generation_run_id text;
alter table assets add column if not exists kind text not null default 'text';
alter table assets add column if not exists qa_decision text not null default '';
alter table assets add column if not exists review_status text not null default '';
alter table assets add column if not exists frame_rate double precision;
alter table assets add column if not exists transcript text not null default '';
alter table assets add column if not exists scenes text not null default '[]';
alter table assets add column if not exists provider_job_id text not null default '';
alter table assets add column if not exists media_status text not null default '';
alter table assets add column if not exists error text not null default '';
alter table assets add column if not exists variant_index integer not null default 0;

create table if not exists media_jobs (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  asset_id text not null,
  creative_id text not null,
  generation_run_id text not null,
  provider text not null,
  provider_job_id text not null default '',
  model text not null default '',
  prompt text not null default '',
  prompt_version text not null default '',
  status text not null,
  state text not null default '{}',
  error text not null default '',
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists media_jobs_run_idx on media_jobs (generation_run_id, status);
