# Engine budget and cost ledger (W12)

Implements Video Engine Bible **section 14** (budget and cost engine), with the estimate step of **6.5**, the pre-flight hold
of **6.1** and the ledger's storage interface for **5.4**. Pure logic over `LedgerStore`. No database code is in this folder.

## Files

- `store.ts`: the `LedgerStore` interface (create, get and update a reservation; append an entry; set an actual; sum
  reserved and actual for a workspace month) and `memoryLedgerStore()` for tests.
- `estimate.ts`: `estimatePlan(plan)`. Prices each paid call from `config/prices.ts`: one line for a generate, component,
  stock or asset shot, and one line per call for a chain (contract v5), so every link is reserved. Adds the fixed per-master
  lines (`fixedBudgetLines()`, from `config/budgets.ts`), and adds the redo allowance on generated lines (a chain's calls
  are generated). Throws `UnknownPriceError`, naming the shot, when a price is unknown.
- `reserve.ts`: `reserve(store, input)` reserves a plan's estimate against the request budget and the workspace month.
  `authorizeCall` authorizes one paid call against its reservation before it is submitted.
- `preflight.ts`: `reserveFixed(store, input)` is the pre-flight hold at intake. `extendReservation(store, input)` raises it
  to the plan's estimate at estimate_reserve. Both are in the section below.
- `reconcile.ts`: `reconcileCall` records the actual cost from the provider's bill (contract v6: never an estimate), and the
  provider's own id for the call (`providerRef`, contract v9). `releaseReservation` releases the unused part.
- `reconcile-holds.ts`: `reconcileHolds(sql, ...)` settles a workspace's held calls whose bill can now be read (contract v9). It is
  the one file here with database access (see budget/STATUS.md).

## Pre-flight hold (lead decision, 2026-10-14)

The paid stages before the plan (`analyze_reference`, `voice`, `plan`) need a reservation to authorize against, and no plan
exists yet. The decision, by the lead:

- **Intake** creates the request's reservation for the fixed per-master lines only (`budgets.fixedPerMasterUsd`, 14.2:
  $0.40 Claude roles, $0.05 critic, $0.05 render, $0.02 speech and ffmpeg, $0.52 in all). `reserveFixed` makes it. It has
  no shot lines and no redo allowance.
- **estimate_reserve** raises that same reservation to the full plan estimate, plus the redo allowance. `extendReservation`
  does it. The reservation's lines become the plan's lines, and the fixed lines stay inside them (the plan includes them).
- **Both steps** check the request budget (`constraints.budgetUsd`) and the workspace month. In **cap** mode, a step that
  would exceed either one pauses the request, with the reasons. It does not fail. Warn and observe behave as in `reserve()`.

Rules for the two functions (tested in `preflight.test.ts`):

- `reserveFixed` is idempotent on `reservationId`. A repeated call returns the stored hold and stores nothing new.
- `extendReservation` never lowers the hold: the new hold is the larger of the plan's amount and what the reservation holds.
- A plan amount below what the reservation has already committed is **refused**, and the hold is not lowered. The plan does
  not cover what was spent.
- A **paused** pre-flight hold (cap mode, intake over budget) holds nothing. The extension refuses it. A new reservation is made
  once the budget allows, under a new `reservationId`.
- A **released** reservation is refused.
- In cap mode, an extension that would exceed a budget **pauses and writes nothing**. The reservation keeps its current hold and
  state, so the calls already made stay counted in the month. A paused extension is retried after the budget changes.
- A reservation counts in the workspace month it was made in (`sumForMonth`). `extendReservation` therefore refuses to extend
  a reservation in a different month from its `createdAt`. A new reservation is needed. The `now` of an extension must be in
  the reservation's month.
- The month check excludes the reservation's own current hold before it adds the new one. A month that fits exactly at its
  budget is not over it.
- An unknown price or an invalid plan throws before anything is read or stored.
- Extending again with the same plan writes nothing (idempotent).

## Behaviour by mode (`BudgetReservation.mode`)

| Mode | Reserve over budget | Call over reservation | Actual above hold |
| --- | --- | --- | --- |
| `observe` | Reserved, no alert | Authorized, no alert | Recorded, no alert |
| `warn` | Reserved, overrun alert | Authorized, overrun alert | Recorded, alert |
| `cap` | Paused with reasons (no exception) | Refused, nothing recorded | Recorded, alert |

Production runs in `cap`. The pre-flight hold and its extension follow the same table, with the pause rule above.

## Rules

- `ScenePlan.estimatedUsd` is the shots-only figure. The estimate adds the fixed lines and the redo allowance.
  `estimatePlan(plan).shotsUsd` must equal it. The test suite checks this on the fixture plan.
- Each entry is held at its estimate until it is reconciled. An entry's hold is its `reservedUsd`. A reservation's
  `reservedUsd` is never below what is committed (the sum of each entry's actual, or its hold).
- A duplicate idempotency key returns the existing entry and never bills twice. A duplicate key with a different
  payload is returned with `samePayload: false`.
- Reconciling a call twice keeps the first actual.
- `LedgerRow` adds the workspace and the reservation to the contract's `LedgerEntry`. The contract type stays exact.
- A Claude call passes its `role` and `promptVersion` to `authorizeCall` (contract v2, Bible section 4 v2 note). They are
  set together: one without the other is refused as `invalid_input` before anything is written. A call that is not a
  Claude call carries neither field.
- A ledger row that fails the `LedgerEntry` contract is refused as `invalid_input` (an `EngineError`), before it is stored.

## Signatures

```ts
reserveFixed(store, { requestId, workspaceId, mode, requestBudgetUsd, workspaceMonthBudgetUsd, now, reservationId? }): Promise<ReserveResult>
extendReservation(store, { reservationId, plan, requestBudgetUsd, workspaceMonthBudgetUsd, now }): Promise<ExtendResult>
// ExtendResult: { status: 'extended', reservation, changed, alerts } | { status: 'paused', reservation, reasons, alerts } | { status: 'refused', reservation, reason }
```

## For the Postgres implementation (eng-pipeline)

`authorizeCall`, `reconcileCall`, `reserveFixed` and `extendReservation` read, then write. On Postgres each must run in one
transaction with a row lock on the reservation (and, for the two reservation functions, on the workspace's month totals), and
the idempotency key needs a unique index. The memory store is atomic only because it is single-threaded.
