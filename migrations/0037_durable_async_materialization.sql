-- Durable linkage for asynchronous production materialization.
--
-- creative_plan_id: the plan a production job belongs to, so plan completion can be
--   decided from durable job outcomes rather than from the request that submitted them.
-- materialized_at / materialized_creative_id: set only after the creative, asset, and
--   bookkeeping rows for a completed artifact exist. A COMPLETED job without
--   materialized_at is still owed materialization and is claimed again by the poller.

alter table production_jobs
  add column if not exists creative_plan_id text,
  add column if not exists materialized_at timestamptz,
  add column if not exists materialized_creative_id text;

create index if not exists production_jobs_creative_plan_idx
  on production_jobs (organization_id, brand_id, creative_plan_id);

create index if not exists production_jobs_unmaterialized_idx
  on production_jobs (status)
  where status = 'COMPLETED' and materialized_at is null;
