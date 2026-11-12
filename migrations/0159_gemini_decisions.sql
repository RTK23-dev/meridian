-- Migration 0159: Gemini as a decision engine.
--
-- A workspace can choose Gemini (Google) as its decision engine, next to TypeSafe JEV, OpenAI and OpenRouter. Its model is chosen per
-- workspace from Google's own model list (decisions/gemini-models.ts), so nothing here names a model. Two checks that listed the engine
-- ids are widened, and the workspace's chosen model has its own table. Additive: no existing row changes.

alter table decision_engine_settings drop constraint if exists decision_engine_settings_engine_id_check;
alter table decision_engine_settings
  add constraint decision_engine_settings_engine_id_check
  check (engine_id in ('jev', 'openai-decisions', 'openrouter-decisions', 'gemini-decisions'));

alter table decision_gate_records drop constraint if exists decision_gate_records_engine_id_check;
alter table decision_gate_records
  add constraint decision_gate_records_engine_id_check
  check (engine_id is null or engine_id in ('jev', 'openai-decisions', 'openrouter-decisions', 'gemini-decisions'));

create table if not exists decision_engine_gemini_config (
  organization_id text primary key references organizations (id) on delete cascade,
  model text not null check (length(model) between 1 and 128),
  updated_by text not null,
  updated_at timestamptz not null default now()
);
