-- Engine orchestration checks (Video Engine Bible 5.4, 6.13, 19 E4 and E5). Numbered after 0080.
--
-- 1. A decision may be made by the deterministic editor (contract v4, Bible L7): engine_decisions.decided_by allows 'editor'.
-- 2. A Claude role call may be a frame reader (contract v4): engine_role_calls.role is checked against every role the contracts
--    name (CLAUDE_ROLES in src/engine/contracts/ledger.ts). The list here must match that list; a test reads both.
--
-- Both constraints are widened or added, never narrowed, so no stored row can break. The table definitions are unchanged.

alter table engine_decisions drop constraint if exists engine_decisions_decided_by_check;
alter table engine_decisions
  add constraint engine_decisions_decided_by_check check (decided_by in ('scorer', 'director', 'human', 'editor'));

alter table engine_role_calls drop constraint if exists engine_role_calls_role_check;
alter table engine_role_calls
  add constraint engine_role_calls_role_check check (role in (
    'segmenter', 'genome', 'request_classifier', 'planner', 'director_check', 'tightener', 'critic_take',
    'critic_final', 'prompt_fixer', 'variant_writer', 'frame_reader'
  ));
