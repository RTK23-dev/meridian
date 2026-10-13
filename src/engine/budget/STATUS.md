# STATUS: engine budget and cost ledger (W12)

Phase E1, wave A. Branch `engine/e1-w1-w12`, based on e0245c9. Covers `src/engine/budget/`. Config it reads is in
`src/engine/config/` (see `contracts/STATUS.md`).

## Done

- `LedgerStore` interface (create, get and update a reservation; append an entry; set an actual; sum reserved and actual
  for a workspace month) and `memoryLedgerStore()` for tests. No database code.
- `estimatePlan`: prices each shot from config, adds the fixed per-master lines (about $0.52), and adds the 25% redo
  allowance on generated shots only. An unknown price throws `UnknownPriceError` naming the shot. It never returns 0.
- `reserve`: reserves against the request budget and the workspace month. In cap mode an over-budget reservation is
  stored as `paused` with reasons. Repeating a reservation id returns the first one.
- `authorizeCall`: records each paid call before submission. Cap refuses a call that would exceed the reservation.
  A duplicate idempotency key returns the existing entry and never bills twice.
- `reconcileCall`: records the actual. The provider's bill is used when known; else the list price, flagged
  `actualIsEstimate: true`; else the held amount, flagged. Raises the reservation on overrun. `releaseReservation`
  returns the unused part.

## Tests (run in this worktree)

- `NODE_ENV=development node --experimental-strip-types --test 'src/engine/budget/**/*.test.ts'`: 51 pass, 0 fail
  (estimate 13, reserve 20, reconcile 12, store 6).
- The fixture plan estimates to the fixture reservation line for line, and its shot total equals the plan's own
  `estimatedUsd`.
- Typecheck and lint: see `contracts/STATUS.md` (both pass; no findings in `src/engine`).

## Live run: owner

No live API was called. The owner's checks for this workstream:

1. Run 10 test renders through `authorizeCall` and `reconcileCall` with the provider's bills. Confirm the render line
   stops being an estimate once the render price is verified.
2. Check the redo allowance (25%, `budgets.redoAllowanceShare`) against observed redo spend, and tune it through the
   learning loop (16.2).
3. Ask eng-pipeline to run these tests against the Postgres `LedgerStore` as well. The memory store is single-threaded.

## Interpretations (lead to confirm)

- `reserve` pauses only in cap mode. Warn and observe record the reservation and, for warn, return an alert. The
  Bible says production runs in cap and does not say what the other modes do at reserve.
- Monthly totals: a reservation counts in the month it was created. A call's actual counts in the month it happened.
  Paused reservations count for nothing.
- A released reservation's `reservedUsd` shrinks to the committed amount, so the month gives back the unused part.
  Calls still open keep their hold.
- An overrun in warn or observe raises the reservation to the committed amount, so the monthly total stays right. In cap
  a call that would overrun is refused, and a cost above the hold after the fact is recorded and alerted.
- A generated shot's estimate is its length times its takes times the route price. Nothing is rounded up to a provider's
  minimum length; reconcile replaces the estimate with the real cost.
- A call's hold equals its own estimate. Its committed amount is its actual when known, else the hold.

## Blockers

None.
