-- Migration 0141: the cookbook a content factory run was made from (round 3, K13, decision D6).
--
-- cookbook_selection holds the record of the choice (cookbook id, version, values, how it was chosen, what the selector first proposed).
-- It is null for a run made without a cookbook. It is written only while the run is a draft: once the run has started, the record is fixed.

alter table content_factory_sessions add column if not exists cookbook_selection jsonb null;
