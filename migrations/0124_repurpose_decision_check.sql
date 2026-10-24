-- The decision check made on a repurpose plan, recorded on its run. One check is made for the whole plan, when the run is planned, and a
-- rejection creates no run. not_consulted means no decision engine answered (none connected, or the check did not run): the deterministic
-- plan still goes ahead, and the row says so.
alter table content_factory_repurpose_runs
  add column if not exists gate_outcome text not null default 'not_consulted'
    check (gate_outcome in ('approved', 'review', 'rejected', 'not_consulted')),
  add column if not exists gate_reason text not null default '',
  add column if not exists gate_engine text,
  add column if not exists gate_record_id text;
