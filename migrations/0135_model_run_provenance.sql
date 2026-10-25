-- What each ordinary model run actually used, not only what was asked for. model_source says where the requested model came from: the
-- workspace's own choice, the deployment default, or an explicit model in code. returned_model and generation_id are what OpenRouter
-- reports for the call. cost_usd is the cost OpenRouter reported; it stays null when it reported none, and is never an estimate.
-- Existing rows keep the empty defaults and a null cost: nothing about an earlier run is back-filled.

alter table model_runs add column if not exists model_source text not null default '';
alter table model_runs add column if not exists returned_model text not null default '';
alter table model_runs add column if not exists generation_id text not null default '';
alter table model_runs add column if not exists cost_usd numeric(14, 8);
