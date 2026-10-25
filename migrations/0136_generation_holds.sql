-- The budget hold for each ordinary text-generation call (src/lib/meridian/providers/generation-ledger.ts). A row is written before the
-- request is sent, with the worst-case cost of that call in estimate_usd and status 'in_flight'. It is then settled once: 'completed'
-- with the cost the provider reported in cost_usd, 'failed' when the provider refused it before generating (nothing billed), or
-- 'uncertain' when the outcome is unknown (a timeout, a server error, a reply that cannot be read). An uncertain or in-flight hold
-- keeps counting against the month until it is settled, so a call that may have been billed is never forgotten.
--
-- cost_usd stays null when the provider reported no cost. It is never estimated; the estimate is kept separately.

alter table model_runs add column if not exists estimate_usd numeric(14, 8);

create index if not exists model_runs_org_month_idx on model_runs (organization_id, created_at);
