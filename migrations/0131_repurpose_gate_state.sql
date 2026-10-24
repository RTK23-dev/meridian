-- The decision check's state, beside its outcome (repurpose-gate.ts). The outcome alone could not tell an uncalibrated answer from a
-- review that a calibrated threshold asked for, so the state names which one it is:
--   not_consulted     no brand, or no engine call was made
--   not_configured    the workspace has no decision engine
--   failed            the engine was called and did not give a usable answer
--   uncalibrated      the engine answered, but no calibrated threshold applies: not a verified decision
--   review_required   calibrated, and the policy asks for a human review
--   approved          calibrated approval
--   rejected          calibrated rejection (the only state that can stop a plan)
-- The check is advisory. An uncalibrated answer never approves or rejects anything. Rights, integrity and the reviewer's decision stay
-- mandatory, whatever the check says.
--
-- Rows written before this migration have no state. An 'approved' or 'rejected' outcome already carried its calibration, so it keeps its
-- meaning. A 'review' outcome did not record whether a calibration applied, so it becomes 'uncalibrated', the conservative reading.

alter table content_factory_repurpose_runs
  add column if not exists gate_state text not null default 'not_consulted'
    check (gate_state in ('not_consulted', 'not_configured', 'failed', 'uncalibrated', 'review_required', 'approved', 'rejected'));

alter table content_factory_repurpose_variants
  add column if not exists gate_state text not null default 'not_consulted'
    check (gate_state in ('not_consulted', 'not_configured', 'failed', 'uncalibrated', 'review_required', 'approved', 'rejected'));

update content_factory_repurpose_runs
set gate_state = case gate_outcome when 'approved' then 'approved' when 'rejected' then 'rejected' when 'review' then 'uncalibrated' else 'not_consulted' end;

update content_factory_repurpose_variants
set gate_state = case gate_outcome when 'approved' then 'approved' when 'rejected' then 'rejected' when 'review' then 'uncalibrated' else 'not_consulted' end;

alter table content_factory_repurpose_runs
  add constraint content_factory_repurpose_runs_gate_state_outcome check (
    (gate_state = 'approved') = (gate_outcome = 'approved') and (gate_state = 'rejected') = (gate_outcome = 'rejected')
  );

alter table content_factory_repurpose_variants
  add constraint content_factory_repurpose_variants_gate_state_outcome check (
    (gate_state = 'approved') = (gate_outcome = 'approved') and (gate_state = 'rejected') = (gate_outcome = 'rejected')
  );
