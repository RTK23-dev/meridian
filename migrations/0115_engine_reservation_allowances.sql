-- The overrun allowances of a reservation (owner direction 2026-10-23): the request budget and the workspace month budget, each with its
-- overrun tolerance, fixed when the reservation is made. Nullable and additive: a reservation made before this migration keeps its budgets
-- as its limits, which is the strict behaviour it always had.

alter table engine_reservations add column if not exists request_allowance_usd numeric(14, 4) check (request_allowance_usd >= 0);
alter table engine_reservations add column if not exists month_allowance_usd numeric(14, 4) check (month_allowance_usd >= 0);
