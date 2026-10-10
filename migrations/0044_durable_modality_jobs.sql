-- 0044: Durable production jobs for every modality (P4b-2).
--
-- modality: what a job produces. Existing rows were all video, which was the only durable path before this migration.
-- sequence_index / parent_job_id: an ordered child (for example a carousel slide) points at its parent job. Carousel
--   parents use these in P4b-3; they are present now so the lifecycle has one shape.
-- cost_status: the state of the job's cost estimate: verified, configured, unknown, or stale (see production/pricing.ts).
--   Legacy rows keep it null, because their estimate predates this record.
-- estimated_cost_cents becomes nullable. An unknown cost is stored as NULL, never as zero.

alter table production_jobs
  add column if not exists modality text not null default 'video',
  add column if not exists sequence_index integer,
  add column if not exists parent_job_id text references production_jobs(id) on delete restrict,
  add column if not exists cost_status text,
  alter column estimated_cost_cents drop not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'production_jobs_modality_check') then
    alter table production_jobs
      add constraint production_jobs_modality_check
      check (modality in ('video', 'image', 'carousel', 'audio', 'mixed_media'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'production_jobs_cost_status_check') then
    alter table production_jobs
      add constraint production_jobs_cost_status_check
      check (cost_status is null or cost_status in ('verified', 'configured', 'unknown', 'stale'));
  end if;
end $$;

create index if not exists production_jobs_parent_idx
  on production_jobs (parent_job_id)
  where parent_job_id is not null;
