-- Plan lineage (P3a; see creative/lineage.ts and docs/INTELLIGENCE_ROADMAP.md).
--
-- decision_id is the persisted JEV decision a creative plan was produced under. The BEFORE INSERT trigger refuses
-- any new plan without one. It is an insert trigger, not a CHECK constraint, so existing plans stay updatable:
-- a status transition on a legacy plan must not be blocked by lineage it was never given.
--
-- Legacy plans were produced from their brief's decision: generateStudioVariants gates that decision before it
-- plans. Those rows are backfilled from the brief. Plans whose brief has no decision keep a null decision_id.
-- Their evidence refs were never recorded, so they are not fully traced (see the roadmap's open questions).

alter table creative_plans add column if not exists decision_id text;

update creative_plans p set decision_id = b.decision_id
from briefs b
where b.id = p.brief_id and b.organization_id = p.organization_id
  and p.decision_id is null and coalesce(b.decision_id, '') <> '';

create or replace function creative_plans_require_lineage() returns trigger
language plpgsql as $$
begin
  if new.decision_id is null or btrim(new.decision_id) = '' then
    raise exception 'creative_plans_decision_lineage: a creative plan must record the JEV decision it was produced under';
  end if;
  return new;
end;
$$;

drop trigger if exists creative_plans_decision_lineage on creative_plans;
create trigger creative_plans_decision_lineage
  before insert on creative_plans
  for each row execute function creative_plans_require_lineage();
