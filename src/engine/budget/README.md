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
- `line.ts`: `startsBelowLine(committed, line)`, the one test of a budget line (D12). `tolerance.ts` is not used by the brief
  path, which D12 moved to the line. The orchestrator still imports it; the lead removes it after the orchestrator change.
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
- **Both steps** note a hold that is above the request budget (`constraints.budgetUsd`) or the workspace month. In **cap** mode
  the note does not pause or refuse the hold (D12): each call is gated by its line (see the budget line section below).

Rules for the two functions (tested in `preflight.test.ts`):

- `reserveFixed` is idempotent on `reservationId`. A repeated call returns the stored hold and stores nothing new.
- `extendReservation` never lowers the hold: the new hold is the larger of the plan's amount and what the reservation holds.
- A plan amount below what the reservation has already committed is **refused**, and the hold is not lowered. The plan does
  not cover what was spent.
- A **paused** pre-flight hold (only one stored before contract v11, since v11 never pauses a hold for its size) holds nothing.
  The extension refuses it. A new reservation needs a new `reservationId`.
- A **released** reservation is refused.
- An extension above a budget **is written, with a note** (D12). The hold is the plan's estimate, and the calls already made stay
  counted in the month.
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
| `cap` | Reserved, with a note (D12) | Authorized with an alert below the budget line; refused at the line, nothing recorded | Recorded, alert |

Production runs in `cap`. The pre-flight hold and its extension follow the same table.

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
// ExtendResult: { status: 'extended', reservation, changed, alerts } | { status: 'refused', reservation, reason }
```

## For the Postgres implementation (eng-pipeline)

`authorizeCall`, `reconcileCall`, `reserveFixed` and `extendReservation` read, then write. On Postgres each must run in one
transaction with a row lock on the reservation (and, for the two reservation functions, on the workspace's month totals), and
the idempotency key needs a unique index. The memory store is atomic only because it is single-threaded.

## Budget line (owner direction, 2026-10-23, D12)

A budget is a line, not a tolerance. The brief path has no percentage and no cents. `line.ts` holds the one test: a paid step
starts only while the spend is below the line (`startsBelowLine`).

- **A call starts only below the line.** In cap mode, `authorizeCall` refuses a call when, before the call, the reservation's
  committed amount is at or above its request budget, or the workspace month's amount is at or above its month budget. The
  committed amount of a reservation is `committedFor`: each entry's actual cost, or its hold until it settles. The month's amount
  is the reserved total `sumForMonth` returns, the figure `reserve()` has always checked against the month (see the open
  decisions below).
- **A call that starts finishes.** It may take the reservation above its hold. The hold is raised to what the call takes it to,
  and the overshoot of each budget is returned as an alert, so it is recorded, not hidden.
- **A plan above a budget is held with a note.** `reserve`, `reserveFixed` and `extendReservation` never pause or refuse a hold
  for its size. A plan whose estimate is above the budget is accepted (D12); the line is what stops its calls.
- **A reservation with no budget has no line.** In cap mode an overrun of its hold is refused (fail closed).
- **The retired fields.** `requestAllowanceUsd` and `workspaceMonthAllowanceUsd` are not written from contract v11. A row stored
  before v11 keeps them, and no budget rule reads them.

Open for the owner, found while building this (budget/STATUS.md has the detail):

- The month's amount is the store's reserved total, so each open plan's full hold counts before any call is made. A plan whose
  estimate reaches the month budget refuses its first call, though nothing is committed. D12 counts committed spend (settled, plus
  the holds of calls in flight or failed). The store gives no such month total, so it is not built.
- A reservation that a verified bill takes above its hold becomes `exceeded` in cap mode (`reconcile.ts`). `authorizeCall` then
  refuses every later call on it, even below the line.
- A reservation paused before v11 stays paused, and no call on it is authorized.
