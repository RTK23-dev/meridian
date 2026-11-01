-- Engine contract v13 (Video Engine Bible section 4, the v13 migration note): engine_role_calls.role allows cookbook_selector, the role that
-- proposes cookbooks for a run (round 3, K10; decision Q34). The check is the list from migration 0108 with one value added. Nothing else
-- in the table changes, and an existing row keeps its role.

alter table engine_role_calls drop constraint if exists engine_role_calls_role_check;
alter table engine_role_calls
  add constraint engine_role_calls_role_check check (role in (
    'segmenter', 'genome', 'request_classifier', 'planner', 'director_check', 'tightener', 'critic_take',
    'critic_final', 'prompt_fixer', 'variant_writer', 'frame_reader', 'model_chooser', 'scriptwriter', 'orchestrator_plan',
    'cookbook_selector'
  ));
