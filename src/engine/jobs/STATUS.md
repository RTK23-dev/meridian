# STATUS: engine jobs and orchestration (W2)

Phase E1, wave B. Branch `engine/e1-w2`, cut from `code/beautiful-cori-1zfk11` at 7fd32ae (which holds the Bible, the
contracts, config and budget). Covers `src/engine/jobs/`, `migrations/0077_engine_core.sql`, and one branch in
`src/lib/meridian/jobs/execute.ts`. Nothing is pushed.

## Done

- **Migration** `migrations/0077_engine_core.sql`: the 11 Bible 5.4 tables (`engine_requests`, `engine_artifacts`,
  `engine_gate_results`, `engine_decisions`, `engine_ledger`, `engine_reservations`, `engine_manifests`,
  `engine_review_items`, `engine_kits`, `engine_cache_index`, `engine_events`). Each has `organization_id not null` and a
  foreign key to `organizations`. Child rows use composite keys `(organization_id, id)` so they cannot point at another
  workspace's rows. `engine_ledger` has `unique (organization_id, idempotency_key)`. A trigger refuses UPDATE on
  `engine_artifacts`. Money is `numeric(14,4)`. Engine jobs reuse the `jobs` table (no `engine_jobs`).
- **Registry** (`registry.ts`): the 14 stages as `engine.<stage>` plus `engine.poll`. Timeouts from `thresholds.jobs.leaseMs`
  (2, 10 and 5 minutes), `maxAttempts` 3 from `thresholds.jobs.maxAttempts`, paid flag, artifact reads and writes, gate.
- **Orchestrator** (`orchestrator.ts`, pure): `advance(state, event)` applies one result (or a dead job, resume, or human
  choice) and schedules everything that became ready. Covers the Bible 3 graph, the 5.3 routing (redo with rule-name hints,
  downgrade with a Decision and a replan, escalate with a review item listing every take and its verdict artifact,
  Critic confidence below 0.6 escalates), variant fan-out to stages 9 to 12, delivery after the master and variants.
- **Orchestrator SQL** (`orchestrator-sql.ts`): one transaction per event, the request row locked, the event recorded
  under a dedupe key, effects written, jobs inserted on `jobs` with key `engine:<requestId>:<stage>:<subjectId>:<attempt>`
  and `depends_on` set to the finished job. `recordDeadEngineJobs` records dead engine jobs that Meridian marked dead
  without calling the engine.
- **Dispatch** (`dispatch.ts`): `executeEngineJob(sql, job, runtime)`. Refuses another workspace's payload, a paid stage
  without a reservation (before any call), and an unregistered stage (`not_implemented`, never a success). Enforces the
  stage timeout. On the last attempt a failure is recorded as a dead letter against the stage.
- **Poller** (`poller.ts`): a produce job that submits stores the external reference on an `engine.poll` job and returns.
  Each poll step asks once: pending re-queues with backoff (5 s, doubling, capped at 60 s, never past the deadline), done
  runs the stage's finish step, failed throws with the provider's retry flag, timeout cancels and fails.
- **Output validation** (`validate.ts`): stage and subject must match the job; ids have their prefixes; gates and verdicts
  parse against their contracts.
- **Artifact store** (`artifact-store.ts`): `writeArtifact` and `readArtifact`. Bodies are validated with the contract on
  write and on read; `contentHash` from the contracts; a stored JSON body whose hash no longer matches is an internal error.
  Media goes through an object-store port (`MediaStorePort`) under `engine/{workspaceId}/{requestId}/{stage}/{artifactId}.{ext}`.
  The port is checked at compile time against Meridian's Drive-backed store. No S3 code.
- **Ledger store** (`sql-ledger-store.ts`): the budget's `LedgerStore` on `engine_reservations` and `engine_ledger`. A
  duplicate idempotency key returns the stored entry. `withReservationLedger` and `withWorkspaceLedger` run each budget call
  in one transaction under a row lock, as the budget README requires.
- **Tests**: 96 in `src/engine/jobs/*.test.ts` (in 9 files, listed in README.md). Run on PGlite (PostgreSQL in WebAssembly, in
  process) with every migration applied in order, so unique keys, row locks, foreign keys and the immutability trigger are
  checked by a real Postgres engine.

## Tests run in this worktree

- `NODE_ENV=development node --experimental-strip-types --test 'src/engine/jobs/**/*.test.ts'`: **96 pass, 0 fail** (PGlite).
- `NODE_ENV=development node --experimental-strip-types --test 'src/lib/meridian/jobs/**/*.test.ts'`: 4 pass, 0 fail.
- Other Meridian suites that reach the executor (`webhooks/job`, `factory/claims-gate`, `factory/factory`,
  `publishing/hypit-performance`, `blockers`): 37 pass, 0 fail.
- `npm run typecheck`: exit 0.
- `npm run lint`: 0 errors, 4 warnings, the same four as the untouched baseline (`src/components/`). None in my files.
- `npm test` (the full suite): exit 0. `scripts/**/*.test.mjs`: 146 pass. `src/**/*.test.ts`: 2573 tests, 2532 pass,
  0 fail, 41 skipped. The 41 skips are existing tests gated on `MERIDIAN_PG_TEST_URL`, which is not set here.

## Owner must run live (no PostgreSQL server or keys are available to agents)

1. **Apply the migration on a real PostgreSQL server.** It needs migrations 0001 to 0076 applied first, and `vector`
   available (0019 creates the pgvector extension). With `DATABASE_URL` set, `npm run db:migrate` applies 0077. Expected:
   the file applies cleanly, and `select count(*) from information_schema.tables where table_name like 'engine_%'` is 11.
2. **Run the engine suite against that server.** The test helper creates a fresh database per test file from the admin URL:
   `MERIDIAN_PG_TEST_URL=postgres://<user>@<host>:5432/postgres NODE_ENV=development node --experimental-strip-types --test 'src/engine/jobs/**/*.test.ts'`.
   The same tests run through `createPoolSql`, the adapter the worker uses. This path was written but **not run**: there is
   no server here, and the sandbox refused to start a local one. Attach the output to the PR.
3. **Check the worker's connection supports transactions.** `scripts/worker-entry.ts` uses `createPoolSql(pool)`, which has
   `begin`. Every engine event needs it; without it an event fails closed. Confirm this in the deployed worker.
4. **Confirm the values** in `settings.ts`: priorities (rush 10, normal 100, batch 1000) and the poll backoff.
5. **Decide the analysis lease.** Bible 15.1 puts uncached analysis at 60 to 120 s of wall time. The brief gives Claude
   stages 2 minutes, so a long reference will time out and dead-letter. Decide whether analysis belongs in the 10-minute class.

## Decisions made here (lead to confirm)

- **`not_implemented` is not in `ENGINE_ERROR_KINDS`** (`contracts/errors.ts`, owned by eng-contracts). `notImplementedError`
  in `types.ts` sets the kind with a cast. Ask eng-contracts to add the kind, then replace the cast.
- **Config.** The brief says to add missing values to `engine/config/thresholds.ts`. This workstream's write scope excludes
  config, so the values the config lacks live in `src/engine/jobs/settings.ts`: the priority numbers, the poll backoff, and
  the analysis retry count (6.2). Move them into `thresholds.ts` (eng-contracts or the lead). Everything else is read from
  config: `leaseMs`, `maxAttempts`, `qualityRedosPerShot`, `criticConfidence`, `voice.paceRetries`,
  `plan.validationAttemptsBeforeEscalation`.
- **Timeout class per stage.** Two minutes (Claude class): intake, analyze_reference, plan, estimate_reserve, check_take,
  edit, compose, pre_render_gate, post_render_review, variants, deliver. Ten minutes (generation): voice (TTS), produce_shot.
  Five minutes (render): render. Timeouts are enforced in `dispatch.ts` and `poller.ts`, because Meridian's worker renews a
  fixed 120-second lease. The work itself cannot be forced to stop. The abort signal is passed to the handler.
- **Intake pre-flight reservation.** Analysis and voice are paid and run before the plan is priced. The orchestrator will
  not queue them without a `budgetReservationId` on the request, so the intake handler must create a pre-flight reservation
  (Bible 6.1 step 6, fixed lines) and pass its id. Nothing in W2 creates it. W12 or W6 must, and must release it when the
  full reservation replaces it.
- **Downgrade does not re-reserve.** A downgraded shot is replanned, but `estimate_reserve` is not run again, so its new
  cost is not held. W7 and W12 decide whether it should be.
- **Human choices.** `human_choice` accepts a take and stores a gold label. A shot that escalated because its downgrade
  replan failed is retried on `resume`, not by a human picking a take (none exists for that plan). There is no "reject"
  choice yet.
- **Hints are rule names only.** A check's free-text `detail` never reaches a handler's prompt (Bible 1, trust boundaries).
- **Shot redo versus component shots.** A gate that names a component or asset shot downgrades or escalates it. Such a shot
  has no produce job, so a redo would wait forever.
- **`dispatch` branch in `execute.ts`.** One `if` block after `readPayload`. It uses a lazy `import()` (the same pattern as the
  factory branch) so engine modules do not load for other jobs. The path is `../../../engine/jobs/dispatch.ts`.
- **Orchestrator SQL in its own file.** `orchestrator-sql.ts` holds the I/O, so `orchestrator.ts` stays pure (Bible 17.2).
- **Dead engine jobs need a sweeper.** Meridian's `tickSqlJobs` marks a lease-expired engine job dead without calling the
  engine. `recordDeadEngineJobs` records those, but nothing calls it yet. W14 or the scheduler must.
- **Provider calls after a dead poll.** If a poll job dies and the stage is resumed, the produce job submits again. That
  may bill twice if the first provider job is still running. W5 must make submit idempotent under the ledger key and cancel
  on timeout (`ProviderAdapter.cancel`).

## Not built in this wave (later workstreams)

- Stage handlers. None is registered, so every engine job is refused with `not_implemented`. A request can start, and its
  intake job then dead-letters the request. This is correct, not a success.
- The Claude client (W3), the router (W5), the gates (W11), the editor and compose (W8, W9), render (W10), and the variant
  and deliver writers (W13). `engine_manifests`, `engine_kits` and `engine_cache_index` have tables but no writers.
- The review inbox, stage metrics, alerts, replay and the dead-letter sweeper schedule (W14).
- Re-running a shot's downgrade replan after `resume` is covered by tests; the real planner's output is not.

## Blockers

- The PostgreSQL run above (owner). The sandbox has no server, and it refused to start one as another user.
- `not_implemented` in the contracts (eng-contracts). The kind works at runtime, but the type needs the kind added.
