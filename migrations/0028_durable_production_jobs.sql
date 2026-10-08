-- 0028: Durable Production Jobs
-- Extends production_jobs to persist full provider polling, resumption and metadata contracts.

alter table production_jobs
  alter column production_spec_id drop not null,
  add column if not exists request_id text,
  add column if not exists operation_name text,
  add column if not exists status_url text,
  add column if not exists cancel_url text,
  add column if not exists spec_hash text,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists submitted_at timestamptz,
  add column if not exists last_polled_at timestamptz,
  add column if not exists next_poll_at timestamptz,
  add column if not exists error_code text,
  add column if not exists artifact_id text;
