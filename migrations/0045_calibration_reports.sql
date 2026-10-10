-- 0045: Calibration reports (P5c).
--
-- A learned parameter may move to fitted or validated, and may then be used, only with a calibration report for its decision
-- class that shows the change improves prediction on held-out outcomes. The report is stored here, so the gate reads a
-- record that exists, not a claim made in the request.

create table if not exists calibration_reports (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  brand_id text not null references brands(id) on delete cascade,
  decision_class text not null,
  held_out_count integer not null check (held_out_count >= 0),
  brier_before double precision not null,
  brier_after double precision not null,
  created_at timestamptz not null default now()
);

create index if not exists calibration_reports_class_idx
  on calibration_reports (organization_id, brand_id, decision_class, created_at desc);
