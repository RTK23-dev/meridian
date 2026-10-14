# STATUS: engine budget and cost ledger (W12)

## Phase E2: contract version `engine-contracts@2` (current)

Branch `eng-e2-contracts`, based on `origin/code/beautiful-cori-1zfk11` at a4b04c7. Not pushed. Config it reads is in
`src/engine/config/` (see `contracts/STATUS.md`).

### Changes

- **Role on the ledger.** `CallInput` takes an optional `role` (a Bible 11.1 Claude role) and `promptVersion` (`<role>@<n>`).
  They are set together. `authorizeCall` writes them onto the `LedgerEntry` row, so Claude calls are traceable per role.
  A call without a role carries neither field.
- **Refusals are typed.** A role without its prompt version, or the reverse, is refused as `invalid_input` before anything is
  written. A row that fails the `LedgerEntry` contract is also refused as `invalid_input`. It used to throw a raw `ZodError`.
- **Duplicates compare the role.** A duplicate key with a different role or prompt version is returned with
  `samePayload: false`.
- No change to `estimate.ts`, `reconcile.ts` or `store.ts` logic. `LedgerRow` picks up the two fields through `LedgerEntry`.

### Tests (run in this worktree, E2)

- `NODE_ENV=development node --experimental-strip-types --test 'src/engine/budget/**/*.test.ts'`: 56 pass, 0 fail
  (estimate, reserve, reconcile, store). Five new tests in `reserve.test.ts` cover the role fields: a Claude call is recorded
  with them, a non-Claude call has none, a half-set pair is refused, a role outside the Bible list is refused, and a duplicate
  with another role is not the same payload.
- The E1 behaviour tests all still pass unchanged.

### For eng-pipeline (Postgres `LedgerStore`)

- The `engine_ledger` table needs nullable `role` and `prompt_version` columns (no backfill). Its read path must return them when
  set, so the row parses as `LedgerEntry`.
- `gateway/paid.ts` `paidCall` and the Claude client do not pass `role` or `promptVersion` yet. Until they do, Claude calls are
  not traceable per role on the ledger. This is a change for eng-pipeline and the lead, not this workstream.

### Live run: owner

No live API was called. The E1 checks still apply: run 10 test renders through `authorizeCall` and `reconcileCall` to confirm
the render line stops being an estimate, and check the 25% redo allowance against observed redo spend. Ask eng-pipeline to run
these tests against the Postgres `LedgerStore` too.

---

## Phase E1 (historical)

- `LedgerStore` interface (create, get and update a reservation; append an entry; set an actual; sum reserved and actual for a
  workspace month) and `memoryLedgerStore()` for tests. No database code.
- `estimatePlan`: prices each shot from config, adds the fixed per-master lines (about $0.52), and adds the 25% redo allowance
  on generated shots only. An unknown price throws `UnknownPriceError` naming the shot. It never returns 0.
- `reserve`: reserves against the request budget and the workspace month. In cap mode an over-budget reservation is stored as
  `paused` with reasons. Repeating a reservation id returns the first one.
- `authorizeCall`: records each paid call before submission. Cap refuses a call that would exceed the reservation. A duplicate
  idempotency key returns the existing entry and never bills twice.
- `reconcileCall`: records the actual. The provider's bill is used when known; else the list price, flagged
  `actualIsEstimate: true`; else the held amount, flagged. Raises the reservation on overrun. `releaseReservation` returns the
  unused part.

Interpretations (lead to confirm):

- `reserve` pauses only in cap mode. Warn and observe record the reservation and, for warn, return an alert.
- A reservation counts in the month it was created. A call's actual counts in the month it happened. Paused reservations count
  for nothing.
- A released reservation's `reservedUsd` shrinks to the committed amount. Calls still open keep their hold.
- An overrun in warn or observe raises the reservation to the committed amount. In cap a call that would overrun is refused. A
  cost above the hold after the fact is recorded and alerted.
- A generated shot's estimate is its length times its takes times the route price. Nothing is rounded up to a provider's
  minimum length; reconcile replaces the estimate with the real cost.
- A call's hold equals its own estimate. Its committed amount is its actual when known, else the hold.

## Blockers

None.
