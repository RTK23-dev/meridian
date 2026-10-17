-- Engine contract v8 checks (Video Engine Bible section 4, the v8 migration note; Bible 11.1 and 6.x write_script). Numbered after 0098.
--
-- 1. An artifact may be a written_script (the script the engine writes from a brief) or model_choices (one request's orchestrator
--    model choices, Bible 10.5). engine_artifacts.type is checked against the artifact types the contracts name (ARTIFACT_TYPES).
-- 2. A Claude role call may be a model_chooser or a scriptwriter (contract v8). engine_role_calls.role is checked against every role
--    the contracts name (CLAUDE_ROLES in src/engine/contracts/ledger.ts). The list here must match that list; migration-0081.test.ts
--    reads both.
--
-- Both constraints are widened, never narrowed, so no stored row can break. The table definitions are unchanged.

alter table engine_artifacts drop constraint if exists engine_artifacts_type_check;
alter table engine_artifacts
  add constraint engine_artifacts_type_check check (type in (
    'production_request', 'validated_request', 'video_dna', 'voice_track', 'scene_plan', 'budget_reservation',
    'asset_spec', 'take', 'take_verdict', 'edl', 'composition', 'rendered_video', 'gate_result', 'review_result', 'manifest',
    'written_script', 'model_choices'
  ));

alter table engine_role_calls drop constraint if exists engine_role_calls_role_check;
alter table engine_role_calls
  add constraint engine_role_calls_role_check check (role in (
    'segmenter', 'genome', 'request_classifier', 'planner', 'director_check', 'tightener', 'critic_take',
    'critic_final', 'prompt_fixer', 'variant_writer', 'frame_reader', 'model_chooser', 'scriptwriter'
  ));
