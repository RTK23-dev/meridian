-- Calibration per brand and question (NORTH_STAR section 9, question 3; docs/FACTORY.md "Calibration per brand and question").
--
-- A grading question's stated probability is calibrated from the brand's own measured outcomes. Each recomputation stores one report
-- per brand and question version. The newest report is the one the decision gate reads. A report is calibrated only when it has the
-- minimum number of observations and a threshold was found; otherwise it is uncalibrated, with the reason. thresholds and reliability
-- are JSON text, as the other factory columns are.
--
-- The table is named question_calibration_reports, not calibration_reports: calibration_reports (migration 0045) already holds the
-- learned-parameter reports read by learning/calibration-gate.ts, with a different shape.

create table if not exists question_calibration_reports (
  id text primary key,
  organization_id text not null references organizations (id) on delete cascade,
  brand_id text not null references brands (id) on delete cascade,
  question_id text not null,
  question_version text not null,
  method_version text not null,
  status text not null check (status in ('calibrated', 'uncalibrated')),
  reason text not null default '',
  sample_size integer not null check (sample_size >= 0),
  thresholds text not null default '{}',
  reliability text not null default '[]',
  created_at timestamptz not null default now()
);

-- The newest report for a brand, question and version is read by this index.
create index if not exists question_calibration_reports_latest_idx
  on question_calibration_reports (organization_id, brand_id, question_id, question_version, created_at desc, id desc);
