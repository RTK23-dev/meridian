-- Migration 0152: the TypeSafe model a workspace's JEV decisions use.
--
-- decision_engine_jev_config (migration 0133) chooses which service answers JEV decisions. When that service is TypeSafe directly, the model
-- came only from the deployment (TYPESAFE_JEV_MODEL). A workspace can now choose it. Null means the deployment's model is used, as before.
-- Additive: no row changes. The application accepts only the models it has a verified profile for (decisions/decision-catalog.ts).

alter table decision_engine_jev_config add column if not exists typesafe_model text null;
