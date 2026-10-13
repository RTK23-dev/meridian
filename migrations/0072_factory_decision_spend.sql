-- Content Factory: spend from decisions (NORTH_STAR section 8, item 2).
--
-- A decision that calls an engine and reports its token usage writes one metered factory_costs row for its run, with basis 'tokens'.
-- The row names the engine and the model, and holds the prompt and completion tokens. Its dollar cost is written only when a price
-- table entry exists for that engine and model (factory/price-table.ts). The cost is kept in micros (millionths of a dollar), so a
-- decision that costs a fraction of a cent is not rounded to zero. A decision with no entry has a null cost, never zero.
--
-- cents is now nullable. A provider-reported row keeps its cents and has no micros. A token row has no cents; its micros are the
-- priced amount, or null when the model has no price. Caps count the priced micros, so unpriced spend is not counted.
--
-- gate_record_id names the decision. Its row id is derived from it, so one decision writes at most one row.

alter table factory_costs alter column cents drop not null;
alter table factory_costs alter column cents drop default;
alter table factory_costs drop constraint if exists factory_costs_basis_check;

alter table factory_costs
  add column if not exists micros bigint,
  add column if not exists engine text not null default '',
  add column if not exists model text not null default '',
  add column if not exists prompt_tokens integer,
  add column if not exists completion_tokens integer,
  add column if not exists price_version text not null default '',
  add column if not exists gate_record_id text not null default '';

alter table factory_costs
  add constraint factory_costs_basis_check check (basis in ('provider_reported', 'tokens')),
  add constraint factory_costs_cents_check check (cents is null or cents >= 0),
  add constraint factory_costs_micros_check check (micros is null or micros >= 0),
  add constraint factory_costs_priced_check check (basis = 'tokens' or cents is not null);

create index if not exists factory_costs_gate_idx on factory_costs (organization_id, brand_id, gate_record_id);
