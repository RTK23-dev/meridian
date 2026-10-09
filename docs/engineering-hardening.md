# Engineering hardening notes

## Production cost provenance

Budget balances are stored in integer USD micros. A reservation is reconciled in one PostgreSQL statement together with its account balance and ledger entry; failed account invariants leave all three unchanged.

Meridian currently has a pre-generation estimator but no trustworthy provider-reported generation-cost feed. Accordingly, successful generation settles against the estimate using cost basis `ESTIMATED` and estimator version `creative-plan-estimate-v1`. This updates the conservative budget balance, but it is never written to `actual_spent_micros`. Unknown cost cannot be settled and leaves the reservation held for operator reconciliation. If the estimate exceeds the reservation, the overage is recorded and the budget account is set to `EXCEEDED`, which blocks new reservations.

Historical reconciliations created before provenance was stored are migrated to `LEGACY_UNVERIFIED`; they are not represented as provider actuals. The system does not yet automatically replace an estimated settlement with a later provider actual. Until that feed and adjustment workflow exist, budget reporting must keep estimated and legacy-unverified values distinct from provider actuals.

## Discovery durability

Discovery creation and reads require a SQL client. Production discovery runs, discovered items, and page-link frontiers are persisted; there is no in-memory queue or process-local read fallback. Run and item reads require organization and brand scope. A worker whose lease has expired cannot heartbeat, transition to processing, fail, or complete the item; recovery must reclaim the expired frontier row first.
