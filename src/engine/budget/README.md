# Engine budget and cost ledger (W12)

Implements Video Engine Bible **section 14** (budget and cost engine), with the estimate step of **6.5** and the
ledger's storage interface for **5.4**. Pure logic over `LedgerStore`. No database code is in this folder.

## Files

- `store.ts`: the `LedgerStore` interface (create, get and update a reservation; append an entry; set an actual; sum
  reserved and actual for a workspace month) and `memoryLedgerStore()` for tests.
- `estimate.ts`: `estimatePlan(plan)`. Prices each shot from `config/prices.ts`, adds the fixed per-master lines
  (`config/budgets.ts`), and adds the redo allowance on generated shots only. Throws `UnknownPriceError`, naming the
  shot, when a price is unknown.
- `reserve.ts`: `reserve(store, input)` reserves against the request budget and the workspace month. `authorizeCall`
  authorizes one paid call against its reservation before it is submitted.
- `reconcile.ts`: `reconcileCall` records the actual cost (the bill, else the list price flagged as an estimate, else the
  held amount flagged). `releaseReservation` releases the unused part.

## Behaviour by mode (`BudgetReservation.mode`)

| Mode | Reserve over budget | Call over reservation | Actual above hold |
| --- | --- | --- | --- |
| `observe` | Reserved, no alert | Authorized, no alert | Recorded, no alert |
| `warn` | Reserved, overrun alert | Authorized, overrun alert | Recorded, alert |
| `cap` | Paused with reasons (no exception) | Refused, nothing recorded | Recorded, alert |

Production runs in `cap`.

## Rules

- `ScenePlan.estimatedUsd` is the shots-only figure. The estimate adds the fixed lines and the redo allowance.
  `estimatePlan(plan).shotsUsd` must equal it. The test suite checks this on the fixture plan.
- Each entry is held at its estimate until it is reconciled. An entry's hold is its `reservedUsd`. A reservation's
  `reservedUsd` is never below what is committed (the sum of each entry's actual, or its hold).
- A duplicate idempotency key returns the existing entry and never bills twice. A duplicate key with a different
  payload is returned with `samePayload: false`.
- Reconciling a call twice keeps the first actual.
- `LedgerRow` adds the workspace and the reservation to the contract's `LedgerEntry`. The contract type stays exact.

## For the Postgres implementation (eng-pipeline)

`authorizeCall` and `reconcileCall` read, then write. On Postgres they must run in one transaction with a row lock on
the reservation, and the idempotency key needs a unique index. The memory store is atomic only because it is
single-threaded.
