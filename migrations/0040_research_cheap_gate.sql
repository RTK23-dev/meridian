-- Cheap ranking before expensive research (see research/gate.ts).
--
-- gate_score is the ordering score from metadata alone; it is a seed prior, not a calibrated probability.
-- gate_reason is 'admitted' or the reason an ad was skipped. An ad the gate skipped has analysis_status
-- 'gate_skipped', so it is not left pending forever.

alter table research_ads add column if not exists gate_score double precision;
alter table research_ads add column if not exists gate_reason text not null default '';

alter table research_ads drop constraint if exists research_ads_analysis_status_check;
alter table research_ads add constraint research_ads_analysis_status_check
  check (analysis_status in ('pending', 'analyzed', 'review', 'NOT_CONNECTED', 'failed', 'gate_skipped'));
