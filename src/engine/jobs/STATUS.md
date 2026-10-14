# STATUS: engine jobs and orchestration (W2)

Branch `eng-e3-pipeline`, from `origin/code/beautiful-cori-1zfk11` at aa3bcf8. Covers `src/engine/jobs/` (handlers, stores, poller,
orchestrator), `migrations/0080_engine_asset_stores.sql`, one new function in `src/engine/gateway/download.ts`, the claude key
change in `src/engine/claude/client.ts`. Nothing is pushed. The lead merges.

## What is built

- **`handlers/produce-shot.ts`** (Bible 6.6, 10.4, 15.2). `createProduceShotHandler({ generator, stock, downloader, media, objects })`.
  - Generate shots go to a `ShotGenerator`. `routerGenerator(routerFor)` runs the asset router on the request's reservation
    (`scopedLedgerStore`, so each budget step is locked per reservation). The router's report maps to a `ShotProduction` by
    `productionFromReport`; every fact is kept, nothing is inferred.
  - Stock shots: `stock(...)` (the W5 `searchStock` through the gateway). The clip is the first of the search's clips whose length is
    within `thresholds.take.durationTolerance` of the shot. If none fits, the hold is `stock_duration`. The clip is free (list price 0).
  - Every take: the file is downloaded through the gateway (`gateway/download.ts`, https only, size-limited), checked to be an mp4,
    probed through the media functions, and kept only when it is H.264, 1080 x 1920, with a known duration. Normalisation needs a
    media function that is not built, so any other shape is an `invalid_output` hold, not a take.
  - The Take is written as an artifact with its media under the Bible 5.2 key (`mediaKey`). The take's `uri` is that key, and the
    artifact row's `storage_key` is the same key. Take ids and spec ids are stable (sha256 of request, shot and attempt), so a
    retried job names the same take. The seed depends on the attempt, so a redo never hits the first take's cache entry.
  - Holds, not failures. A budget refusal returns a `budget` hold with the paid reason. A `content_policy` or `invalid_input` refusal
    returns a `refused` hold whose hint is the rule-style name (`content_policy`, `invalid_input`, `invalid_output`, `stock_no_match`,
    `stock_duration`). Other router outcomes (every candidate failed, bucket full, not connected, duplicate) are thrown, so the job
    retries and, when dead, pauses the request.
  - Asynchronous generators (Bible 15.2): `run` returns `submitted` when the generator submits; `finish` settles the call through
    `generator.settle`. The router in this repository is synchronous (see blockers).
- **`handlers/check-take.ts`** (Bible 6.7, 12.2). `createCheckTakeHandler({ gateway, media, objects, scorer?, measure?, paletteHex?,
  metrics? })`. It reads the take and the scene plan, takes six evenly spaced frames (PNG data URLs) from the stored file, calls
  `runTakeCheck` (code checks, similarity, the Critic through `runRole` on the request's reservation, with the request's role-call
  journal), and writes the verdict as a `take_verdict` artifact. Defaults fail closed: the scorer is not connected, the palette,
  product and persona lists are empty (not evaluated), the measurements beyond the probed duration are null (missing), and no gold
  metrics are loaded (nothing can block on a learned threshold). A take whose media is missing from storage throws `not_found`.
- **`handlers/register.ts`**: `registerEngineHandlers(runtime, { estimate_reserve, produce_shot, check_take })`. A stage not
  registered stays `not_implemented`.
- **`asset-stores-sql.ts`** (Postgres stores for the router, organization-scoped): `sqlProviderStats`, `sqlBreakerStore`,
  `sqlBucketStore` (a lease row per slot, the bucket row locked, expired leases ignored), `sqlAssetCache` (first write wins, hits
  recorded against the request), and `scopedLedgerStore(sql, org, reservationId)`.
- **`migrations/0080_engine_asset_stores.sql`**: `engine_provider_attempts`, `engine_provider_breakers`, `engine_buckets`,
  `engine_bucket_leases`, `engine_asset_cache`, `engine_asset_cache_hits`. Every table has `organization_id` not null and a foreign
  key to `organizations`. The hits table also has a composite foreign key to `engine_requests`. Migration 0079 is the monthly budget
  on the main branch, so this file is 0080 as the lead asked.
- **Orchestrator** (`orchestrator.ts`, pure). Shots carry a plan `epoch` (0 at the first plan, +1 per replan). A produce output
  carries its epoch; a result from an older epoch is recorded (`stale`), never checked and never counted. A refusal sends the shot
  back to the planner once (`prompt_rewrite`, plan job with directive `rewrite` and the hint); a second refusal downgrades or
  escalates. A budget hold pauses the request (`kind: budget`, with the reason) and resume queues the job again. A dead produce or
  check job of an older epoch changes nothing. Produce outputs can carry the router's decisions, which become `engine_decisions`.
  The escalation review item adds `detail.review`, the `takeReviewItem` payload (`meridian.take_review/v1`) built from the verdicts
  check_take returned. The review payload is built where the escalation is decided, so there is one copy of it.
- **Poller**: a refused provider answer (content_policy, invalid_input) goes to the stage's `finish` as a `failed` poll state, and
  becomes the hold. Any other failure still throws and retries. `StageContext.poll` carries the provider reference to `finish`.
- **Registry**: `check_take` reads `take` and `scene_plan`. The orchestrator passes the plan slot to the check job.
- **Validation** (`validate.ts`): a produce output names exactly one of a take and a hold; a hold must match `produceHoldSchema`
  (a budget reason, or a refusal with a rule-style hint); the epoch is a whole number from zero.
- **Settings**: `jobSettings.promptRewrites = 1` (Bible 10.4).

## Claude key change (`src/engine/claude/client.ts`)

The idempotency key of a role call now includes the request id (`callKey`, `CallContext.requestId`). Before, the key was the hash of
role, prompt version, model and input, so identical input in two requests was one ledger call. The second request then got
`duplicate` and no answer, and every take that was a cache hit (same frames) escalated. The key still repeats for a retry within a
request. `client.test.ts` now expects the request in the key. Lead: this changes the key of every role call; there is no live data yet.

## Tests (PGlite, this worktree)

- `NODE_ENV=development node --experimental-strip-types --test 'src/engine/jobs/**/*.test.ts' 'src/engine/jobs/handlers/*.test.ts' 'src/engine/gateway/**/*.test.ts' 'src/engine/claude/**/*.test.ts' 'src/engine/review/**/*.test.ts'`: **456 pass, 0 fail, 0 skipped.**
- New files: `e3-pipeline.test.ts` (one request from plan through estimate, produce and check, a stock shot and a generated shot, both
  accepted; the ledger, role calls, attempts, cache, decisions and downloads are all checked), `asset-stores-sql.test.ts` (tenancy,
  breaker, buckets with leases, the cache's first write, the locked ledger), `handlers/produce-shot.test.ts` (20),
  `handlers/check-take.test.ts`, `produce-output.test.ts`, `gateway/download.test.ts`. Extended: `orchestrator.test.ts` (five E3 tests),
  `migration.test.ts` (0080 and the new tables; no fixed last file), `poller.test.ts`.
- `npm run typecheck`: exit 0. `npm run lint`: 0 errors, 4 warnings, the same four in `src/components/` as the baseline.
- Recorded responses: `jobs/test/fixtures/` holds copies of the asset and review recorded responses (OpenRouter video submit, poll and
  policy failure, the Pexels search, the Critic's answer). The media bytes, the probe results and the frames are stand-ins with the
  recorded shapes, labelled as such in `test/harness.ts`. No test calls a live API.

## Owner must run live

1. Apply `migrations/0080_engine_asset_stores.sql` on a real PostgreSQL server after 0078 and the main branch's 0079. Expected: it
   applies cleanly and the six new `engine_*` tables exist with `organization_id` not null.
2. Run the same suite against that server: `MERIDIAN_PG_TEST_URL=postgres://<user>@<host>:5432/postgres NODE_ENV=development node --experimental-strip-types --test 'src/engine/jobs/**/*.test.ts' 'src/engine/jobs/handlers/*.test.ts'`.
3. Live produce and check, one stock shot and one generated shot, with a credential for OpenRouter and Pexels through the resolver and
   a reservation of at most $1. Record: the take ids and their `uri` keys, the Take `durationMs` from the probe, the ledger actual for
   the generated call against the activity page, the Critic's ledger rows and role-call rows, and the verdicts. Expected and honest
   result: the take gate escalates the similarity checks (no scorer vendor, Bible 20.2) and the flicker, black-frame and motion checks
   (no media functions yet). Record that as the result. Do not record it as a pass.
4. `video.cinematic` (Kling) is `verified: false` in `config/routes.ts`. Run `verifyRoutes` and set it (lead, after the W5 live run).

## Blockers and decisions for the lead

- **The router is synchronous.** `AssetRouter.produce` submits and polls inside one paid call, so a generated take never returns
  `submitted`. The handler's submit-and-settle path is built and tested with a fake generator. The live path needs a W5 change: a
  submit-only result carrying the job reference, the ledger authorized at submit and reconciled at settle (`reconcileCall` is
  exported), and `generator.settle` wired to it. Until then no worker blocks for minutes, but every generated call blocks inside
  its job (bounded by the generation lease).
- **The intake pre-flight hold** is yours. The e2e test gives intake a real reservation as a placeholder so voice and plan can be queued,
  and estimate_reserve makes the plan's reservation. No intake code changed.
- **Normalisation.** No media function normalises to 1080 x 1920 at 30 fps. A take of another shape is refused for the planner. The
  fps is not checked. Bible 6.6 step 4 is only partly met.
- **Similarity and measurements.** The scorer vendor (Bible 20.2) and the flicker, black-frame and optical-flow measurements are not
  built, so the take gate escalates. Kits (style palette, product hero, persona portraits) are not loaded, so those checks are not
  evaluated and escalate. The kit store is E3 work.
- **Composition root.** `registerEngineHandlers` is ready, but no worker composes the ports yet: the gateway, the router factory with
  its image and speech media store, the stock search, the downloader, the object store and the media functions. The runtime still
  refuses every stage not registered.
- **Asset stores are per organization** (as asked). That means provider health and the breaker are per workspace, not global as
  Bible 10.4 describes. Lead decision.
- **Bucket full** throws a retryable provider error, so the job retries, and when dead the request pauses. A delayed re-queue would be
  better. Follow-up.
- **Budget alerts** from the router are not persisted by the handler. They belong to the budget module.
- **Rules I chose** (lead to confirm): `motionRequired` is true for generated and stock shots, since the plan has no motion flag. A
  stock clip is taken only if its search length is within the take tolerance of the shot, because takes are not trimmed. A stock
  licence stays `unverified` in the decision text (E2.6). A take with no connected evidence escalates.
- **Ledger role columns.** `engine_ledger` has no `role` and `prompt_version` columns, so a Claude call's role is not stored on the
  ledger row (the PHASE_LOG follow-up). The role call journal does keep them. Migration needed; not in this change.

## Not built in this wave

- The intake pre-flight hold, the planner (rewrite and downgrade plans), the edit, compose, render and post-render stages, the
  similarity scorer, the flicker and motion measurements, and the kit store.

---

## E2 pipeline fixes (branch `eng-e2-pipeline`, from `origin/code/beautiful-cori-1zfk11` at a4b04c7)

Covers `src/engine/jobs/`, `migrations/0078_engine_role_calls.sql`, and the claude client's resume path in
`src/engine/claude/client.ts` and `src/engine/claude/journal.ts` (eng-pipeline owns `claude/`; the change was needed for item 3).
Nothing is pushed. The lead merges.

### Item 1: intake advances without a reservation (done, with an open blocker)

- `applyIntake`: a passing intake sets `intake` passed and no longer pauses on a null reservation. A reservation id that intake
  does give is kept as the request's hold (the handler never gives one).
- **Blocker, not built: the paid stages before `estimate_reserve` still need a reservation.** `analyze_reference`, `voice` and
  `plan` are `paid: true` in `registry.ts`, and Bible 5.1 and 14 say no paid call happens without a reservation. The brief's rule
  ("only stages after estimate_reserve require one") would let those three run unreserved, which the project rules forbid, so
  I did not implement it. Instead `schedule()` pauses the request on budget at the first ready paid stage with no reservation,
  and names it (`analyze_reference`, or `voice` when the DNA is cached). Nothing is queued unreserved, and nothing fails.
- Effect in practice: a request now runs intake, then pauses at analysis with the reason "analyze_reference is a paid stage and
  needs a budget reservation on the request". The pipeline cannot pass analysis until the lead decides one of:
  (a) a pre-flight hold at intake (the minimum from `minimumMasterBudgetUsd`, released by estimate_reserve), which the
  orchestrator already accepts from intake; (b) a different design. The lead must decide before any live run.
- Tests: `orchestrator.test.ts` (intake pass without reservation advances; the first paid stage pauses and is named; voice
  with a cached DNA; a reservation from intake queues analysis and voice; estimate_reserve is queued with the plan and the
  request artifacts). `orchestrator-sql.test.ts` (the same through PostgreSQL, the jobs table holds only the intake job).

### Item 2: estimate_reserve reads the request budget; the monthly budget has a source (done)

- `registry.ts`: `estimate_reserve` reads `scene_plan` and `production_request`. `orchestrator.ts` passes the `request` slot
  (the production_request artifact) with the plan.
- `handlers/estimate-reserve.ts`: the request budget is `constraints.budgetUsd` from that artifact. The workspace monthly budget
  comes from a `WorkspaceBudgetSource` (`monthBudget`), passed in `createEstimateReserveHandler({ workspaceBudget })`.
- The default source, `notConnectedWorkspaceBudget`, returns `status: "not_connected"` with a reason. The stage then refuses
  to reserve: the gate fails with `reservation_succeeded` and the reason, no reservation id is returned, and nothing is stored.
  The orchestrator pauses on budget with that reason. A source that returns an unusable amount (NaN, negative) is refused too.
- Owner question (Bible 20.2): where the workspace monthly budget is set. Until it is, every master pauses at estimate_reserve.
- Tests: `handlers/estimate-reserve.test.ts` (14 pass), including the default source, a source's own refusal reason, unusable
  amounts, and a missing `production_request` input.

### Item 3: persisted role calls (done)

- `migrations/0078_engine_role_calls.sql`: `engine_role_calls`, organization-scoped with composite foreign keys to the request
  and the reservation, unique on `(organization_id, request_id, idempotency_key)`. Status is `pending`, `answered`,
  `invalid_answer` or `refused`. Check constraints refuse an answered row without its answer and a settled row without its
  ledger entry.
- `claude/journal.ts`: the `RoleCall` type (moved from the client, re-exported by it) and the `RoleCallJournal` port.
- `claude/client.ts`: `RoleDeps.journal` is optional. Without it nothing changes. With it: a `pending` entry is written inside
  the paid call, before the gateway is asked; `answered` (with the validated answer) or `invalid_answer` (with its issues) once
  it settles; `refused` when the reservation does not cover the call. Resume: a stored answer is reused with no call; a stored
  invalid first answer means only the retry is sent; a stored invalid retry fails the stage again with no call. The outcome has
  `resumed` (stored calls this run used) next to `calls` (new calls). `RoleAnswerError.attempts` counts both.
- `jobs/role-call-store.ts`: `sqlRoleCallJournal(sql, { organizationId, requestId })` implements the port (scoped to the
  request). `listRoleCalls`, `manifestRoleCalls` (the billed `RoleCall`s, in order) and `promptVersionsOf` (role to version;
  two versions of one role in one request is refused) feed the manifest.
- Money is stored at four decimals (`numeric(14,4)`), like the ledger. OpenRouter's `0.057866` is kept as `0.0579`.
- **The Manifest contract has no role-call field.** The manifest writer (W13) reads `manifestRoleCalls` and `promptVersionsOf`.
  Adding a field to `meridian.manifest/v1` is a contract change (eng-contracts, lead approval).
- Known gap: a call that starts and never returns leaves a `pending` row and its hold. Its key is a duplicate on the ledger, so a
  resume with the same attempt makes no second call and reports `duplicate`. A job retry with a new attempt number is a new key
  and bills again (the existing rule, Bible 5.1). The answer of a call whose journal write fails after it was billed is lost: the
  stage then fails closed. The journal write and the ledger write are not in one transaction (the paid-call wrapper is shared).
- Tests: `role-call-store.test.ts` (9: the transitions, tenancy, malformed entries refused by code and by the database, order,
  billed-only manifest list, two prompt versions refused) and `role-call-resume.test.ts` (6: a crash after the answer, the
  retry-only resume after a refused retry, a refused first call resumed after a top-up, a started call that never came back,
  a stored invalid retry, and a reservation that belongs to another request). Recorded fixtures only.

### Migration tests

- `migration.test.ts`: `0078_engine_role_calls.sql` is the newest migration; `engine_role_calls` is in the table list with
  `organization_id not null` and a foreign key.

### Checks on this branch (this worktree, PGlite)

- `NODE_ENV=development node --experimental-strip-types --test 'src/engine/jobs/**/*.test.ts' 'src/engine/claude/**/*.test.ts'`:
  177 pass, 0 fail.
- `npm run typecheck`: exit 0.
- `npm run lint`: 0 errors, 4 warnings, the same four in `src/components/` as the baseline.

### Owner must run live (in addition to the E1 list below)

1. Apply `migrations/0078_engine_role_calls.sql` on a real PostgreSQL server after 0077. Expected: it applies cleanly, and
   `engine_role_calls` exists with `organization_id not null`.
2. Run `src/engine/jobs/role-call-*.test.ts` against that server with `MERIDIAN_PG_TEST_URL` set (same command as below). These
   use recorded fixtures, so no key is needed.

## Done in E1

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
- **Intake pre-flight reservation (superseded in E2, see the top of this file).** Analysis and voice are paid and run before
  the plan is priced. The orchestrator will not queue them without a `budgetReservationId` on the request. Intake does not
  reserve; the pre-estimate paid stages now pause the request on budget until the lead decides the pre-flight hold.
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
