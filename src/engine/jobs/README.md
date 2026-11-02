# Engine jobs and orchestration (W2)

Implements Video Engine Bible **section 3** (the 14 stages as job types), **5.1** (jobs), **5.2** (artifacts), **5.3** (gates,
redo, downgrade and escalate), **5.4** (tables, with `migrations/0077_engine_core.sql`), **15.2** (asynchronous provider calls),
**15.5** (dead letters) and the **14** ledger store (for the budget package in `src/engine/budget/`). The stage work itself
(analysis, planning, production, rendering) is not here. Stage handlers are injected.

## Files

| File | What it does |
| --- | --- |
| `registry.ts` | The 14 stage specs and `engine.poll`: job type, group, timeout class, attempts, paid flag, artifact reads and writes, gate. Idempotency key builder. |
| `settings.ts` | The values engine config does not hold yet: priority numbers, poll backoff, analysis retries (see STATUS.md). |
| `types.ts` | Events, stage outputs, the job payload and its zod schema, handler and runtime types, `withTimeout`, the `not_implemented` error. |
| `orchestrator.ts` | **Pure** core. `advance(state, event)` applies one event and returns the next state, the jobs now ready, and the effects to persist. No I/O, no clock. It dispatches each event to the family modules below, and keeps the start and the control events (dead, resume, human choice). |
| `orchestrator-state.ts` | The state shapes, the limits, and the checks and lookups more than one family uses. |
| `orchestrator-single.ts` | The single-node results: intake, the script, the plan, the estimate, the gates and delivery. |
| `orchestrator-shots.ts` | The shot results: produce, hold, the take check, the rounds and the shot escalations. |
| `orchestrator-branch.ts` | The branch results: edit, compose, the pre-render and post-render reviews, and the revisions. |
| `orchestrator-variants.ts` | The variant results: the variant runs, their produce and check, and the assembly. |
| `orchestrator-remake.ts` | The remake events: a shot remade while it is still making, and a remake of a delivered request. |
| `orchestrator-schedule.ts` | Scheduling: every node whose inputs are ready and not yet queued is queued after an event. |
| `orchestrator-sql.ts` | The thin SQL layer. Starts a request, applies one event under a row lock, writes effects and state, inserts jobs on Meridian's `jobs` table, records dead engine jobs the engine never saw. |
| `dispatch.ts` | `executeEngineJob(sql, job, runtime)`: what Meridian's worker runs for every `engine.*` job. Called from the one branch in `src/lib/meridian/jobs/execute.ts`. |
| `poller.ts` | Asynchronous provider calls: store the external reference on a poll job, backoff, finish or fail the stage, time out. |
| `validate.ts` | Boundary checks on a stage's output: the stage and subject match the job, ids have their prefixes, gates and verdicts parse. |
| `artifact-store.ts` | `writeArtifact` and `readArtifact` for `ArtifactEnvelope`s. JSON bodies in `engine_artifacts`; media bytes through Meridian's object-store port under the Bible 5.2 key. |
| `sql-ledger-store.ts` | The budget's `LedgerStore` on `engine_reservations` and `engine_ledger`, with the row locks the budget README asks for. |
| `role-call-store.ts` | The `RoleCallJournal` of one request on `engine_role_calls` (migration 0078). Lets a resumed Claude call reuse its stored answer or send only its retry. Lists the RoleCall records for the manifest. |
| `handlers/` | The `intake`, `estimate_reserve`, `produce_shot` and `check_take` stage handlers, and `register.ts` (their own STATUS.md). |
| `asset-stores-sql.ts` | The asset router's Postgres stores (attempts, breaker, buckets, cache), organization-scoped, and the ledger for one reservation whose budget steps are locked. Migration 0080. |
| `stable-id.ts` | Ids that do not change on a retry (take, spec, seed), from a sha256 of the job's labels. |
| `test-db.ts` | Test helper only. PGlite (PostgreSQL in process) with every migration applied in order. |

## How a request moves

1. `startEngineRequest` writes the request row and queues `engine.intake`.
2. A stage job runs its handler and returns a result. `executeEngineJob` checks it (`validate.ts`), then calls
   `applyEngineEvent` with dedupe key `job:<jobId>`. A second run of the same job is a no-op.
3. `advance` applies the result and schedules everything that became ready. Jobs carry the idempotency key
   `engine:<requestId>:<stage>:<subjectId>:<attempt>` (Bible 5.1), so a repeat insert does nothing.
4. The new jobs set `depends_on` to the job that finished (Meridian's single-parent dependency). A fan-in such as `plan`
   (analysis and voice) is queued only when both are passed, so the orchestrator, not the queue, waits for all parents.

## Routing (Bible 5.3)

- **Take fails:** redo the shot with the failing rule names as hints (up to `thresholds.jobs.qualityRedosPerShot`, 2).
  After the redos, downgrade to `downgradeTo` (a `plan` job for that shot, plus a Decision). With no downgrade, escalate.
- **Critic confidence below `thresholds.escalation.criticConfidence` (0.6)**, or the Critic's own `escalate` action:
  escalate, even if the take passed.
- **Other gates:** DNA retries once (6.2), voice retries twice (6.3, `paceRetries`), plan redoes once then escalates (6.4),
  edit, compose, render and post-render redo up to 2 times, then escalate. A failed budget pauses (not fails) the request.
- **Shot-level failure after the EDL exists** (pre-render or post-render naming shots): only those shots go back, and the
  EDL is rebuilt.
- **Escalation** pauses the request and writes a review item listing every take of the shot, with its verdict artifact and
  the plan artifact. `human_choice` accepts a take and stores a gold label. `resume` continues once no shot needs a choice.
- **Dead job** (retries exhausted): the request pauses with its artifacts kept and a dead-letter review item. `resume` queues
  the stage again.

## Fail-closed rules

- A paid stage (`registry.ts`, `paid: true`) is never queued without `budgetReservationId` on the request. `advance` pauses
  instead, `schedule` throws if it is ever reached, `queueJobs` refuses, and `dispatch` refuses before the handler runs.
- Intake does not reserve. A passing intake advances. The first paid stage with no reservation on the request (analysis, voice,
  or the plan before estimate_reserve) pauses the request on budget and names the stage. This is open: the lead decides the
  pre-flight hold (see STATUS.md, E2 item 1).
- A stored Claude answer is reused only after it passes the role's contract again. A resume never sends a call that the
  journal shows was already billed and answered.
- A handler that is not registered throws `not_implemented` and is never recorded as done.
- A result for another stage, another subject or another workspace is refused. Stale and duplicate results throw `conflict`.

## Key decisions

- **Tenancy column is `organization_id`.** Every other Meridian table uses it. The Bible's `workspaceId` is the same value.
- **Timeouts are enforced here.** Meridian's worker renews a fixed 120-second lease with a heartbeat, so the per-type
  timeouts (2, 10 and 5 minutes) are applied by `withTimeout` in `dispatch` and `poller`. The work cannot be forced to stop;
  the abort signal tells a handler to stop its provider call.
- **Hints are rule names only.** Free text from a model (a check's `detail`) never reaches a prompt (Bible 1, trust boundaries).
- **Artifacts are immutable.** A trigger refuses UPDATE on `engine_artifacts`. A redo writes a new artifact.
- **No S3.** Media goes through the object-store port (`MediaStorePort`), which Meridian's Drive-backed store satisfies
  (checked at compile time in `artifact-store.ts`).

## Tests

`NODE_ENV=development node --experimental-strip-types --test 'src/engine/jobs/**/*.test.ts'`. The SQL tests run in PGlite with
every migration applied, so unique keys, row locks, foreign keys and the immutability trigger are checked against
PostgreSQL semantics. The owner's live check against a PostgreSQL server is in STATUS.md.
