# STATUS

## The budget is a line (D12, contract v11; owner direction 2026-10-23)

Branch `feat/budget-line-engine`. Round 1 is `9408cb71` on `6862bb52`; round 2 (committed-spend lines, and `exceeded` only at a line)
follows it, and round 3 (a paid call starts only if its own hold fits the line, D17) follows that. Committed, not pushed; the lead merges.

**Change list.**

- **Round 1: the line on the brief path.**
  - `reserve()` has no tolerance input. A plan above a budget is held with a note, never refused for its size.
  - `authorizeCall`, cap mode, refuses a call only at a line, or when a reservation with no budget overruns its hold (fail closed). Both
    tests use `startsBelowLine` (`line.ts`). A call that starts raises its hold to what it takes it to and returns its overrun as alerts.
    In cap mode that is new; before, only warn returned them. Observe still returns none.
  - `preflight.ts`: `reserveFixed` and `extendReservation` note a hold above a budget. `ExtendResult` loses its `paused` variant. Neither
    writes the allowance fields.
  - `contracts/ledger.ts`: the allowance fields were already optional; their comments say D12 retired them. `version.ts` is
    `engine-contracts@11`. Bible section 4 has the v11 note, with lead approval pending. `contracts/STATUS.md` is not updated, because it
    belongs to eng-contracts.
  - `estimate.ts`: no change; it never had a tolerance. The quote's `fits` already compares with the strict budget.
  - `tolerance.ts`: not edited, not deleted. The orchestrator still imports it.
- **Round 2: committed spend, and `exceeded` only at a line.**
  - `store.ts`: `committedForRequest(requestId)` and `committedForMonth(workspaceId, month)` on `LedgerStore`. Each sums the rows' actual
    cost, or the hold until the row settles: the rule of `committedFor`. A month's rows are the rows whose `at` is in the month.
  - `jobs/sql-ledger-store.ts`: the same two methods over `engine_ledger`. The month filter is the one `sumForMonth` uses.
  - `reserve.ts`: `authorizeCall` reads the request's committed spend across all its reservations (`committedForRequest`), so a remake
    sees the request's earlier spend. It reads the month's committed spend for the month of the call. The hold check stays per
    reservation. `reserve()` is accepted while its month's committed spend is below the month budget; otherwise it is paused, with the
    reason. Its notes compare committed spend plus the plan with each budget.
  - `preflight.ts`: `reserveFixed` is accepted and paused the same way. `extendReservation` notes its raise against the request's and the
    month's committed spend, counting its own reservation's committed spend once.
  - `reconcile.ts`, `settleAndCheck`: in cap mode a settled bill marks the reservation `exceeded` only when the request's committed spend,
    or the month's, is at or above its budget. An overrun of the hold alone raises the hold to the committed amount and keeps the
    reservation `reserved`, with its overrun alert. The mark clears when no line is reached any more. `authorizeCall` refuses a call on an
    `exceeded` reservation only when a line is reached. Paused and released reservations are refused as before. Warn and observe keep
    their behaviour; warn's request alert now reads the request's committed spend.
  - `api/index.ts` (the remake quote): the month check reads the month's committed spend. This is the only line changed in that file, and
    it is outside the redo allowance the file's leave-alone note protects. The lead can revert it.
  - `variants/reserve.ts`: a raise's month check reads the month's committed spend, and the funding adds only what is planned. Its refusals
    are unchanged.
  - Resolved from round 1 and moved here: the month line counts committed spend, not reserved holds (round 1, decision 1); `exceeded`
    only at a line (round 1, decision 2); `WorkspaceMonthBudget.tolerance?` stays optional and unset, because the orchestrator reads it
    (round 1, decision 3, accepted).
- **Round 3: a paid call starts only if its own hold fits the line (D17, owner decision 2026-10-23).**
  - `reserve.ts`, `authorizeCall` (cap mode): a call is refused when, before it, the request's or the month's committed spend is at or
    above its budget (round 2), or when that committed spend plus the call's estimate is above the budget. The second test is
    `positionOfLine`, with the same epsilon as `startsBelowLine` (`line.ts`, unchanged). A call at a line is refused even with a zero
    estimate. The reason names the line the call is at, or the hold that would take it past, one for each budget. A refused call records
    nothing and holds nothing.
  - Kept: a fitting call's overrun raise and its alert; a bill above a fitting hold raises the hold and returns its alerts (`reconcile.ts`
    is unchanged); the fail-closed refusal for a reservation with no budget; warn and observe.
  - `reserve.ts` and `preflight.ts`: a reservation is never paused at a line. `reserve()` and `reserveFixed` store it `reserved`, with the
    notes, whatever the month's committed spend. This supersedes round 2's pause. `monthNotAcceptedReason` is removed. `paused` stays for
    an operator's pause (`pauseEngineSpend`) and for rows stored before v11.
  - `reserve.ts`: the hold raised before `appendEntry` is removed. The hold is raised once, after the entry is written.
  - Bible v11 note and `budget/README.md`: the fit rule, and no pause at a line.

**Tests.** Round 3: budget folder 159 (round 2: 154), all pass. `reserve.test.ts` 38 (was 34): four tests added for D17 (a fitting call
starts; a hold past the request line is refused with nothing committed; a call at the request line is refused with a zero estimate; the
month line), and the pause, crossing, remake and month tests rewritten. `reconcile.test.ts` 19 (was 18): a bill above a fitting hold. Rewritten
to D17: two of five in `tolerance-admission.test.ts`, the pause test in `preflight.test.ts` (of 32), two of eleven in
`jobs/sql-ledger-store.test.ts`, and the earlier call in `render/hyperframesCloud.test.ts`, which now fills the 0.001 line exactly. The two
named tests pass: `render/shotstack.test.ts` "is refused by the budget before any request, as HyperFrames is" and
`orchestrator/production.test.ts` "a call past the request budget is not made" (both failed on round 2). All 281 `src/engine` test files:
3326 tests, all pass. `npm run typecheck` passes, and `npx eslint` passes on the budget folder and the changed test files. The full `npm
test` was not run. Round 2: `reserve.test.ts` 34 (was 32), `reconcile.test.ts` 18
(was 15), `store.test.ts` 8 (was 6), `jobs/sql-ledger-store.test.ts` 11 (was 9); `preflight.test.ts` 32 and `variants/reserve.test.ts` 10
are rewritten for committed spend. `tolerance-admission.test.ts` 5 (its name is kept because no file is deleted). `contracts/v11.test.ts` 5
(new). The wider run (budget, jobs, contracts, config, gateway, assets, variants, render, media speech-to-text, api index, deliver, voice;
122 files) passes 1521 (round 1: 1512). `npm run typecheck` passes, and `npx eslint` passes on the changed files. The full `npm
test` was not run; the lead runs it at merge.

**Decisions for the lead (still open).**

1. **Resolved by D17: a remake is accepted while its request is at its budget.** The acceptance rule reads only the month, as the brief asked. A remake's
   reservation is therefore accepted when its request has already reached the request budget; its calls are then refused at the line. Say
   It is not paused: D17 says a reservation is accepted with a note, and only calls are gated. Its first call is refused at the line.
2. **The orchestrator still compares holds with the month budget.** `orchestrator/run-budget.ts:59` and `orchestrator/service.ts:115` read
   `sumForMonth`. They are outside this change. The orchestrator change must move them to `committedForMonth`.
3. **Variants still refuse a raise past a budget.** `variants/reserve.ts` refuses a raise whose reservation total passes the request budget,
   and one whose month passes its budget. Under D17 a hold that does not fit is refused before any request, so the refusal fits D17; whether a raise should be a note instead is the lead's decision. It is not changed here.

**Doubts and bugs.**

- Fixed in round 3: `reserve.ts`, cap-mode `authorizeCall`, raised the hold before `appendEntry` as well as after it. A duplicate key found
  by the append would have left the hold raised with no entry. Only the raise after the append remains.
- `api/index.ts` (remake): the `state !== "reserved"` guard refuses a paused reservation. Since round 3 no month line pauses one, so the guard
  is reached only by an operator's pause. The file is on the leave-alone list (redo allowance), so the guard itself is unchanged.
- An `exceeded` reservation whose line has cleared authorizes its calls at once, but keeps the `exceeded` state until a later settlement
  on that reservation clears it. The state is a record; the lines decide the calls.
- `jobs/handlers/intake.ts` still rejects a request whose budget is below the fixed lines (`budget_covers_fixed_lines`, $0.52). That is a
  request minimum, not a hold, so it is kept. Say if it should become a note.
- `committedForRequest` has no index on `engine_ledger.request_id`. Migrations are off-limits here, so it scans the workspace's ledger rows
  on each call that reads it (every authorization, reconciliation and reserve). An index on `(organization_id, request_id)` is needed
  before production volume. `committedForMonth` uses the `(organization_id, at)` index only as far as the `to_char` expression lets it,
  as `sumForMonth` already does.
- A reservation paused before v11 stays paused, with no migration: `authorizeCall` refuses it.
- `contracts/ledger.ts:12-13` still says a reservation is paused at creation when its month is at its line. That is a contract comment,
  and eng-contracts owns the contract (a version bump), so it is not edited here. The lead decides.
- `jobs/STATUS.md:13-14` says a hold not accepted because the month is at its budget pauses the request. That file is outside this
  folder and is not edited; it is stale for D17.
- `exceeded` still carries a `pausedReason`, because the contract requires a reason for it. It does not pause: calls are decided by the
  lines. Say if `exceeded` should be removed.
- Resolved by D17: a single step larger than the remaining budget no longer starts; its hold must fit. Still open from D12: two
  reservations in one month can each start a call at the same moment, because the month is read under the reservation lock only. D17
  records that overshoot as a note.
- Still carrying tolerance, outside this change: `orchestrator/{envelope,service,run-budget,run,policy-store,validate,api}.ts` (use
  `tolerance.ts`); `src/components/content-factory/orchestrator-policy-panel.tsx` (shows and edits it); `src/lib/meridian/orchestrator/actions.ts`
  (accepts it); `src/engine/prompts/orchestrator_plan@3.md:19` and `src/engine/claude/roles/orchestrator_plan.ts:45` (describe it). None is
  changed.

**Quality: 4 of 5.** Both lines read committed spend, `exceeded` marks only a line, and each rule is tested at its boundary, including the remake
and the database paths. It is not 5 because the orchestrator still compares holds with the month budget (outside this change), the remake
acceptance question is resolved by D17, and the lines are read under a per-reservation lock, so two reservations can race.

## Bill reads of held calls are tracked and bounded (contract v9, migration 0112)

Fixes the strain: `reconcileHolds` used to read every held call's bill on every run, forever, and rows with no providerRef filled the
100-row batch so that newer calls were never read. Branch `bill-reads-holds` (see the report); `feature/bill-reads` was not touched.

- **Tracking.** `engine_bill_reads` (migration 0112, unchanged) holds one row per held call that has been read or given up. The
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
