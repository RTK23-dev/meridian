-- production_jobs.status is a closed set: the ProductionJobState values (production/types.ts), STORAGE_PERSISTENCE_FAILED
-- (a render that could not be stored durably, until it is retried or failed), and AWAITING_CHILDREN (a carousel parent
-- that waits for its slides; it has no provider call of its own).
-- The database refuses any other value, so no job can sit in a state that no code reads.
--
-- Legacy rows that carry a value outside the set (for example the 'CREATED' and 'SUBMITTED' values named in
-- 0026_unified_meridian_architecture.sql, which no code writes) are failed explicitly, with a recorded reason, rather
-- than left in a state the poller ignores. A failed job's reservation is handled by the existing settlement path.
update production_jobs
set status = 'FAILED',
    error_code = coalesce(error_code, 'LEGACY_STATUS_UNRECOGNISED'),
    updated_at = now()
where status not in (
  'NOT_CONFIGURED', 'PENDING_PREFLIGHT', 'PREFLIGHT_FAILED', 'SUBMITTING', 'AWAITING_CHILDREN', 'SUBMISSION_UNKNOWN', 'QUEUED', 'RUNNING',
  'RENDERING', 'WAITING_FOR_ARTIFACT', 'WAITING_FOR_EXTERNAL_ARTIFACT', 'RENDERED', 'PENDING_POSTFLIGHT',
  'POSTFLIGHT_FAILED', 'COMPLETED', 'FAILED', 'CANCELLED', 'STORAGE_PERSISTENCE_FAILED', 'AWAITING_CHILDREN'
);

alter table production_jobs drop constraint if exists production_jobs_status_check;
alter table production_jobs
  add constraint production_jobs_status_check check (status in (
    'NOT_CONFIGURED', 'PENDING_PREFLIGHT', 'PREFLIGHT_FAILED', 'SUBMITTING', 'AWAITING_CHILDREN', 'SUBMISSION_UNKNOWN', 'QUEUED', 'RUNNING',
    'RENDERING', 'WAITING_FOR_ARTIFACT', 'WAITING_FOR_EXTERNAL_ARTIFACT', 'RENDERED', 'PENDING_POSTFLIGHT',
    'POSTFLIGHT_FAILED', 'COMPLETED', 'FAILED', 'CANCELLED', 'STORAGE_PERSISTENCE_FAILED', 'AWAITING_CHILDREN'
  ));
