-- The brand-fit check made on a rendered repurposed variation, recorded on that variation. It is made once, when the variation is rendered,
-- and it is advisory: a reviewer sees it, and it blocks nothing. not_consulted means no decision engine answered, or the variation was rendered
-- before this check existed, and the row says so.
alter table content_factory_repurpose_variants
  add column if not exists gate_outcome text not null default 'not_consulted'
    check (gate_outcome in ('approved', 'review', 'rejected', 'not_consulted')),
  add column if not exists gate_reason text not null default '',
  add column if not exists gate_engine text,
  add column if not exists gate_record_id text;
