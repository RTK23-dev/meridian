# STATUS

**Chosen call prices (Bible 10.5 step 5, 2026-10-17).** `estimatePlan(plan, chosen?)` and `extendReservation({ chosenPrices })` price a
call whose model the orchestrator chose at its catalog estimate (`ChosenCallPrice`, keyed `callPriceKey(shotId, output)`), with the
chosen model as the line's `provider`. A chosen price that is not positive throws `unknown_price`; no chosen price means the price table.
Tests: `estimate.test.ts` is unchanged; the behaviour is covered in `jobs/handlers/estimate-chosen*.test.ts`.: engine budget and cost ledger (W12)

## Provider refs and the held-call reconciler (contract v9, owner decisions 2026-10-17)

- `store.ts`: `LedgerStore.setProviderRef(entryId, ref)`. Idempotent for the same ref; a different ref for an entry that has one is a conflict.
  Both stores implement it (the memory store here, `jobs/sql-ledger-store.ts` on `engine_ledger.provider_ref`).
- `reconcile.ts`: `reconcileCall` takes an optional `providerRef`, recorded whether or not a bill is given. A bill still settles only
  to a verified bill, and nothing is estimated.
- `reconcile-holds.ts` (new): `reconcileHolds(sql, { organizationId, now, readers })`. It is the one file in this folder with database
  access, which the README above says the folder does not have: it reads the workspace's unsettled rows and settles each under the
  reservation lock (`withReservationLedger`). It reads a bill outside the lock. Readers are per provider (`BillReader`). Rows older than
  five minutes only; no provider ref means `needsOperator`, never a settlement.
- Tests: `reconcile-holds.test.ts` (memory and PGlite): a billed settlement, a late bill, no ref, a young call, another workspace, a
  throwing reader, no reader, and a ref written and read back through the SQL store. Not run by the agent that wrote them.

## Chains: contract version `engine-contracts@5` (current)

- `estimatePlan` prices every call of a chain (contracts `ShotSpec.source` kind `chain`, Bible section 4 "v5"). A chain has one
  budget line per call (stage `produce_shot`, the shot's id, the route key of the call's model class), priced over the call's
  takes. A per-second call bills the shot's length. Every call counts as generated for the redo allowance.
- A generate, component, stock or asset shot keeps one line at its old price, so the fixture reservation is unchanged.
- An unknown price on any call (the stop-motion frames are token-priced) refuses the whole estimate, naming the shot.
- Not changed: `reserve`, `preflight`, `reconcile`, `store` and the cap mode. The ledger's per-call entries need a call id when
  the produce stage writes them (contracts STATUS, decision 4).
- Tests: `estimate.test.ts` (the chain cases above). The budget folder's other tests pass unchanged.

## Phase E3: contract version `engine-contracts@3`

Branch `eng-e3-contracts`, based on `origin/code/beautiful-cori-1zfk11` at aa3bcf8. Not pushed. The lead's brief for E3, item by
item. Fixture-tested only; no live call. Covered by `budget/README.md` (the pre-flight hold section).

### Done

- **Pre-flight hold, `budget/preflight.ts`.** `reserveFixed(store, {requestId, workspaceId, mode, requestBudgetUsd,
  workspaceMonthBudgetUsd, now, reservationId?})` holds the fixed per-master lines only ($0.52 from `budgets.fixedPerMasterUsd`).
  It is idempotent on `reservationId`. Cap pauses it when the request budget or the workspace month would be exceeded.
- **Extension, `budget/preflight.ts`.** `extendReservation(store, {reservationId, plan, requestBudgetUsd,
  workspaceMonthBudgetUsd, now})` raises the hold to the plan's estimate plus the redo allowance, and replaces the fixed lines
  with the plan's lines (the fixed lines stay inside). It never lowers the hold. It refuses a plan amount below the committed
  total. It refuses a paused, released or other-month reservation. In cap it pauses (writes nothing) when a budget would be
  exceeded. Extending again with the same plan writes nothing.
- **Decisions I made where the brief was open (lead to confirm):**
  1. *Extension below committed is refused,* not clamped up to the committed amount. The brief's test list says "refused".
  2. *Cap pause on extension writes nothing.* A paused reservation holds nothing (contract), and pausing the existing hold
     would drop its committed calls from the monthly total. So the reservation keeps its current hold and state.
  3. *Other-month extension is refused.* Holds are counted in their `createdAt` month (`sumForMonth`). Extending in another
     month would put the new amount in a month whose budget was never checked. `now` must be in the reservation's month.
  4. *A paused pre-flight hold is not revived.* Its extension is refused. A new reservation is needed once the budget allows.
- **Fixed lines are exported.** `estimate.ts` exports `fixedBudgetLines()` (was private), so the pre-flight hold and the estimate
  share one definition.
- **Tests, `budget/preflight.test.ts` (32).** Fits; request exceeded (cap pause, warn alert, observe silent); month exceeded
  (cap pause, warn, observe), with the exact-budget boundary; idempotent; invalid inputs; extension fits; fixed lines inside;
  all-code plan; request and month pause write nothing; counting the other holds of the month (boundary 1.4795 fits, 1.4794
  pauses); warn and observe; repeated extension writes once; extension below committed refused; a plan equal to committed
  accepted; never lowered; paused and released refused; other month refused; unknown price and invalid plan throw before any
  write; not_found; invalid extension inputs; the whole flow (hold, analysis call, extension, shot call, reconcile, release,
  monthly totals at the actuals).
- **Not changed:** `reserve()`, `authorizeCall`, `reconcileCall`, `releaseReservation` and `LedgerStore`. The store interface
  needs no new method.

### Checks (this worktree)

- `NODE_ENV=development node --experimental-strip-types --test 'src/engine/budget/**/*.test.ts'`: the budget files (estimate,
  reserve, reconcile, store and preflight) pass with the rest of the E3 sets, 274 in all (see `contracts/STATUS.md`). Preflight
  alone: `# tests 32`, `# pass 32`, `# fail 0`.
- The estimate-reserve handler (`jobs/handlers/estimate-reserve.ts`) still calls `reserve()`, not `extendReservation`. Its
  switch is eng-pipeline's change (see below).

### For eng-pipeline and the lead (not made here)

- **estimate_reserve** must call `extendReservation` with the reservation id that intake stored, not `reserve()` with a new plan
  id. Until then a request has two reservations and the fixed hold is not raised.
- **Intake** must call `reserveFixed` with a stable reservation id (for example from the request id). The orchestrator must then
  take the id from intake, and no longer pause on a null reservation (Bible 6.1 step 8 wording).
- **Postgres `LedgerStore`:** `reserveFixed` and `extendReservation` read the month totals and then write. They run in one
  transaction with a row lock on the reservation (see `budget/README.md`).

## Phase E2: contract version `engine-contracts@2`

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
