-- Typed JEV answers and the policy/calibration versions that produced them.
-- Historical decision rows are not rewritten.

alter table jev_decisions add column if not exists answer text not null default '';
alter table jev_decisions add column if not exists schema_version text not null default '';
alter table jev_decisions add column if not exists policy_version text not null default '';
alter table jev_decisions add column if not exists calibration_version text not null default '';
