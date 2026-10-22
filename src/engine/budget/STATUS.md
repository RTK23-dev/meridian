# STATUS

## Bill reads of held calls are tracked and bounded (contract v9, migration 0111)

Fixes the strain: `reconcileHolds` used to read every held call's bill on every run, forever, and rows with no providerRef filled the
100-row batch so that newer calls were never read. Branch `bill-reads-holds` (see the report); `feature/bill-reads` was not touched.

- **Tracking.** `engine_bill_reads` (migration 0111, unchanged) holds one row per held call that has been read or given up. The
  ledger row is never changed by it. A settled call's row is deleted (by the read that settled it, or by the next run if another path
  settled it).
- **Limits (`reconcile-holds.ts`, beside `HOLD_SETTLE_AFTER_MS` and `HOLD_BATCH_LIMIT`).** `BILL_READ_BACKOFF_MS` = [15 min, 60 min,
  4 h, 12 h]; `MAX_BILL_READS` = 5; `BILL_READ_LEASE_MS` = 10 min; `NO_PROVIDER_REF_REASON` = "no provider reference". They are
  constants, not config: the lead can move them to `config/thresholds.ts` if wanted.
- **Run order.** (1) Untrack calls settled by another path. (2) Reset a given-up no-ref row whose call has since gained a ref (it never
  made a read, so it starts at zero). (3) Give up unsettled no-ref calls, at most 100 per run, with the reason. (4) Select the due calls:
  with a providerRef, unsettled, older than 5 minutes, and either untracked or not given up with `next_read_at <= now`; oldest first, at
  most 100. (5) Read each: claim, then read.
- **Claim before the read.** One statement inserts or updates the call's tracking row. It counts the read (`attempts + 1`), sets
  `next_read_at` to now + lease, and succeeds only while the call is unsettled, not given up, and due. So two overlapping runs (the
  scheduler enqueues one job per workspace every 900 s, with no lock) cannot both read a call, and a call settled after selection is not
  read. The claim that takes the fifth read sets `given_up` at once: a run that dies during that read leaves the call given up, so no
  sixth read is possible. A read cut off earlier is read again when its lease ends, and it counts.
- **Outcome.** A missing reader, a thrown reader, an unavailable bill, or a refused settlement is a failed read, with its reason. No
  reader sends no request. The Nth failure sets `next_read_at = now + BILL_READ_BACKOFF_MS[N-1]`; the fifth sets `given_up` and clears
  `next_read_at`. A billed read settles through `withReservationLedger` and `reconcileCall` (the money path is unchanged), then deletes
  the tracking row. `last_reason` is clipped to 500 characters, the table's limit.
- **Result.** The signature and the existing fields are unchanged. Two changes in meaning, for the lead to confirm:
  - `needsOperator` now reports all unsettled no-ref calls: `count` is the total, `ids` the oldest 100. Before, it counted the no-ref rows
    in that run's batch. The runtime's `operator=` figure therefore stays meaningful each run, not only on the first.
  - `givenUp` is new (a `HoldGroup`, so `count` and `ids`): the no-ref calls given up in this run, and the calls whose fifth read failed
    in this run. Those calls are also in `stillOpen` or `needsOperator`. `runtime.ts` does not print it (that file belongs to another
    agent).
- **Decisions to confirm.** (a) A settlement the ledger refuses counts as a failed read, so it is bounded too. (b) A no-ref call that gains
  a ref is read, once it is due, although it was given up. (c) The claim takes a lease, so it is a small extra write per read.
- **Tests.** `reconcile-holds-reads.test.ts` (17): five reads at most, with the clock moved past each wait; no read before `next_read_at`
  and the waits follow the schedule; 120 given-up calls and 120 no-ref calls do not stop a newer call (given up in batches of 100); a
  settled read settles through the ledger and deletes its row, and the call is never read again; a throwing reader counts as a failed
  read and the run goes on; success after two failures leaves no attempt count; no-ref calls are given up once, with no request; no
  reader counts as a failed read; a late ref is read once; a call settled elsewhere is untracked; an overlapping run does not read a
  claimed call; a 2,000-character reason is clipped; the claim of the fifth read gives the call up before the provider is asked; a crash
  after the fourth read gives up at the last read, and that read is the fifth; a read cut off earlier is read again and counts; a claimed
  read is held until its lease ends. The existing `reconcile-holds.test.ts` (8) passes unchanged, and so does
  `jobs/maintenance.test.ts` (3), which runs the job.
- **Not verified live.** No live provider call was made; the tests use recorded fixtures on the in-process test database. The owner's
  live check: hold one call with its bill withheld, run the job five times on the real database, and confirm the row ends `given_up` with
  five attempts and no further provider request.

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
