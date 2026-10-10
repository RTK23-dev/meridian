-- Decision engines: one active engine per organization, and engine lineage on every decision run.
--
-- Meridian supports interchangeable decision engines (TypeSafe JEV and the OpenAI Decisions API). Exactly one is
-- active for an organization. The selection is stored here, not in the credential vault, so it is queryable and
-- cannot be confused with a credential. An organization without a row uses the deployment default
-- (DECISION_ENGINE), and then 'jev'.
create table if not exists decision_engine_settings (
  organization_id text primary key references organizations (id) on delete cascade,
  engine_id text not null check (engine_id in ('jev', 'openai-decisions')),
  updated_by text not null,
  updated_at timestamptz not null default now()
);

-- Engine lineage on the existing decision ledger. jev_runs and jev_answers keep their names for compatibility; they
-- record decisions from every engine. Rows written before this migration have no engine_id and were made by JEV.
alter table jev_runs add column if not exists engine_id text;
alter table jev_runs add column if not exists adapter_version text;
alter table jev_runs add column if not exists requested_model text;
alter table jev_runs add column if not exists input_modality text;
alter table jev_runs add column if not exists image_count integer not null default 0;
alter table jev_runs add column if not exists usage jsonb;
alter table jev_runs add column if not exists latency_ms integer;
alter table jev_runs add column if not exists failure_kind text;

alter table jev_answers add column if not exists engine_id text;
alter table jev_answers add column if not exists calibration_status text;

create index if not exists idx_jev_runs_org_engine on jev_runs (organization_id, engine_id, created_at desc);
