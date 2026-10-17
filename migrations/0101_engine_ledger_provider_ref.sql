-- Engine contract v9 (Video Engine Bible section 4, the v9 migration note; Bible 14.1 and 10.3). Numbered after 0100.
--
-- 1. A ledger entry records the provider's own id for its paid call (LedgerEntry.providerRef): the Deepgram request id or the
--    OpenRouter generation id. It is null for every entry written before v9, and for a call whose provider named none.
-- 2. The reconciler reads the held calls of a workspace that have no bill yet (budget/reconcile-holds.ts). The partial index covers
--    exactly those rows, so the scan does not read settled history.
--
-- Additive only: no existing column changes, and no existing row is rewritten.

alter table engine_ledger add column if not exists provider_ref text;

create index if not exists engine_ledger_unsettled_idx on engine_ledger (organization_id) where settlement is null;
