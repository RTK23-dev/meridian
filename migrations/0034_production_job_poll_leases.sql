-- Durable lease deadline and update timestamp for independently running production pollers.
alter table production_jobs
  add column if not exists updated_at timestamptz not null default now();

create index if not exists production_jobs_due_poll_idx
  on production_jobs (next_poll_at, created_at)
  where status in (
    'QUEUED', 'RUNNING', 'RENDERING', 'SUBMITTING', 'WAITING_FOR_ARTIFACT',
    'WAITING_FOR_EXTERNAL_ARTIFACT', 'PENDING_PREFLIGHT', 'STORAGE_PERSISTENCE_FAILED'
  );
