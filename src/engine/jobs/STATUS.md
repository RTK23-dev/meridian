# STATUS: engine jobs and orchestration (W2)

## E5 item 3 (generation variants, this branch): built through assembly and the variant's own chain

Status: a generation variant now runs end to end on recorded answers: its work list, its writer, voice and plan phases, its produce and check
jobs, its assembly (the EDL rebuilt by the editor over its own inputs), and its chain (compose, pre-render, render, review). Delivery receives
its EDL. A variant fails alone at every step. The voice is a full re-speak (a recorded deviation); the splice is a recorded future step.
Production does not yet wire the voice or the produce for variants (`../variants/STATUS.md`, blockers).

Full account in `../variants/STATUS.md`. What is in this folder:

- **Work list (`types.ts`, `orchestrator.ts`).** `StageOutput`'s `variants` member is phased: the request phase carries `work`, one item per
  funded generation variant (`variants/work.ts`, `VariantWorkItem`). The writer, voice, plan and assemble phases each report one variant's
  outcome. The orchestrator's variant branch applies each outcome to that variant's run.
- **Variant runs (`variant-runs.ts`, pure).** A run is `preparing` (its phases), then `producing` (one produce job per shot the change makes
  again, then one check per take, with the shot's redos), then `assembling` (its EDL is queued), then `rendering` (its chain), then `produced`
  (the chain passed review) or `failed`. A failure ends that variant alone: it never pauses the request. Its decision is recorded
  (`variantDecision`). State is `OrchestratorState.variantRuns`, absent in older states (read as none).
- **Assembly (`variants/assemble.ts`, phase `assemble`).** Its inputs are its own: its plan, the DNA, its voice (or the master's, for a product),
  the validated request and the takes its EDL plays (`picksOf`: its own take for each shot it changed, the master's accepted take for the rest).
  The edit gate decides it; a passing build writes `edl:<id>` (with `variantOf` the master), and the EDL becomes a branch with `variantKey`.
- **The chain (`applyPreRender`, `applyRender`, `applyPostRender`, `escalateBranch`, `applyDead`).** A variant's chain never revises the
  master's shots or the master's edit (the caption and music chains no longer do either, which was a latent bug). A chain's failure is retried
  in its own stage up to the stage redos, then the variant fails. A dead chain job fails the variant, not the request. A passing review
  produces the variant. The pre-render gate reads the variant's own plan, voice and takes (`preRenderIdsOf`).
- **Scheduling.** Phase jobs are `engine.variants` jobs with subject `variantSubjectOf(key)` and `details.phase`. Produce jobs for a variant
  shot have subject `<variant subject>.<shotId>`, and their inputs are the variant's plan artifact, not the master's. Their takes are named by
  that subject (`handlers/produce-shot.ts`: `takeIdFor`, `assetSpecFor` take the subject; a master job's subject is its shot id, so master ids
  are unchanged). Check jobs read the take and the variant's plan. The take picks are settled before the assembly is queued (`advance`,
  `settleVariantAssembly`).
- **Deliver.** Delivery waits for every variant run to end (`variantsSettled`). The variant's plan and voice stay with its run. Its EDL and
  its takes are request artifacts, so deliver can see the EDL's media (`deliver/manifest.ts` `shotsFor` finds the take of each clip by URI).
  A dead variant job or a refused produce ends its run as `failed`.
- **Scheduling.** Phase jobs are `engine.variants` jobs with subject `variantSubjectOf(key)` and `details.phase`. Produce jobs for a variant
  shot have subject `<variant subject>.<shotId>`, and their inputs are the variant's plan artifact, not the master's. Their takes are named by
  that subject (`handlers/produce-shot.ts`: `takeIdFor`, `assetSpecFor` take the subject; a master job's subject is its shot id, so master ids
  are unchanged). Check jobs read the take and the variant's plan.
- **Deliver.** Delivery waits for every variant run to end (`variantsSettled`). The variant's plan and voice stay with its run, not the
  request's artifacts (deliver reads one scene plan). A dead variant job or a refused produce ends its run as `failed`.
- **Validation (`validate.ts`).** The request phase's work items are validated against `variantWorkItemSchema`. A phase outcome names its
  key and, when not built, its reason. A plan's produce list is validated as shot summaries.
- **Registry (`registry.ts`).** `variants` is a generation-class stage (its voice phase is a generation call). Its writes are EDLs, scene
  plans and voice tracks.
- **Production (`production-ports.ts`, `runtime.ts`, `kit-store.ts`).** `productionVariantPorts` is passed by `productionEngineRuntime`. The
  writer's route is read through the gateway; a route with no key is NOT_CONNECTED with no call. The voice is not connected (no voice port in
  production), so a variant that needs one is NOT_CONNECTED with its reason. `productKitBySku` reads a product kit by its SKU.
- **Not built.** The production voice and produce ports for a variant (the worker's composition). The audio splice (a recorded future step for
  changed-lines-only, not needed for the full re-speak).
- The "Not built" sections below describe the state before this item. The variant sub-graph they name is now built as described here.

## W2 leftovers: wiring pass (branch `eng-e45-leftovers-2`, base 5d5925b)

Owner instruction for this pass: no test, typecheck, lint or golden-frame run. Everything below is written and unverified. The lead runs
`npm test && npm run typecheck && npm run lint && npm run build` after all phases.

### Done

1. **Media detectors (`gate-measures.ts`).** `takeMeasurementsFromDetectors` gives `TakeMeasurements` from black or frozen runs (in
   frames, `longestRunFrames`), flicker and motion, with the values `takeCodeMeasures` gives. `renderMeasuresFromDetectors` gives the
   black frame at each required time (`blackFrameMeasures`) and the silence (`longestMs`). A detector that answers `invalid_input` gives
   null for its measure (missing evidence); any other error throws, so the job retries. `check_take` takes `detectors` (`CheckTakePorts`,
   `ShotPorts.detectors`) and `post_render_review` takes `detectors`. `measure` and `measureBlackFrames` still win when given.
   `check_take` does not read frame_reader: its code measures are the detectors' only.
2. **frame_reader overlays (`post_render_review`).** `frameReader: true` (off by default) reads the rendered frames at each graphics
   clip's midpoint (`readRenderedFrames`, one call per 24 frames) and gives `overlayMeasures`. `measureOverlays` wins when given. OCR
   stays undefined: measurements only (review/STATUS.md decision 5).
3. **analyze_reference readings (`runtime.ts`, `analysisPortsOf`).** With `composition.picture` and no readings of its own, the readings are
   `analysisReadings({ picture, roles })`: the picture measures and the frame_reader captions, shake and speed ramps. Production passes no
   `analysis` yet, so the stage stays not_implemented in production.
4. **Production render and post-render deps (`production-ports.ts`, in `productionEngineRuntime`).** HyperFrames over
   `gateway.transportFor("heygen")` and `secretFor("heygen")`. Shotstack over `transportFor("shotstack")` and `connection("shotstack")`.
   Stored media in Meridian's Drive-backed store (`engineObjectStore`). The render line is priced per minute at the higher of the
   HyperFrames and Shotstack list prices, and is undefined while the HyperFrames price is null, so nothing renders unpriced. Media
   functions over the gateway (`gatewayMediaFunctions`): NOT_CONNECTED while `media_functions` has no base URL.
5. **Shotstack source links (`media-link.ts`, `src/lib/meridian/storage/engine-media-link.ts`).** `sourceUrlResolver`: a
   `not_connected` signer throws a config error starting `NOT_CONNECTED:` with the reason; a `refused` source throws invalid_input; a
   non-https link is refused. The signer makes 15-minute HMAC links (`MEDIA_LINK_SECRET`, 32+ characters; `APP_URL` or `PUBLIC_APP_URL`
   as an https origin). Without either it answers not_connected. A key that is not an engine media key of the organization is now
   `refused`, where it used to throw a plain Error. The route `src/routes/api/engine-media.ts` serves the object behind a link.
   `routeTree.gen.ts` regenerates on the next dev or build (not hand-edited).
6. **Caption fixture that changes captions (`src/engine/jobs/test/caption-variant.ts`).** The chain master with its captions split at
   3 s, so the caption after the presenter really moves. `variants.test.ts` uses it and asserts the change touches only the captions surface.
   `orchestrator.test.ts` asserts a caption variant runs compose, render and deliver and queues no produce_shot, voice or plan job.

### Not built: the generation variant sub-graph (lead item 3)

Not built in this pass, and it is not a wiring change. Blockers, each verified in code:
- The orchestrator's shots, takes and edit are request-scoped (`state.shots`, `state.takes`, the single `edit` node,
  `allShotsAccepted`). A variant needs its own shot and take map, and its own edit before its compose.
- No beat-scoped voice job exists. The voice stage writes one `voice_track` per request from the production request.
- `produce_shot` takes its prompt from the plan shot. No stage writes a variant prompt. `variant_writer` is never called by a stage.
  Product and persona reference imagery is not a produce input.
- Generation would charge the reservation with no path to a finished variant. Generation variants stay `deferred` (no job, no ledger
  row), as before.
Needed, in order: a variant plan and voice artifact per variant (prompts and lines), the product and persona reference sources, the writer
wired into the variants stage, per-variant shot and take keys in the orchestrator state, and the variant EDL built from its takes and voice.
Decision for the lead: keep generation deferred (fail closed, the current behaviour), or open a design for the list above.

### Tests (written, not run)

- `media-link.test.ts` (+1): a refused source is invalid input, and no link is made.
- `src/lib/meridian/storage/engine-media-link.test.ts`: a non-engine key (and an external URL) is `refused`; the TTL case still throws.
- `production-ports.test.ts` (+2): HyperFrames is ready with a HeyGen key and sends nothing; Shotstack is not ready without its key.
- `handlers/check-take.test.ts` (+2): detectors feed the take gate on the take's bytes; a refused detector leaves its measure missing.
- `handlers/post-render-review.test.ts` (+7): detector black frames fail the black check; detector silence is the silence measure; refused
  detectors fail closed; frame_reader on with no overlay fails and with the overlays passes; frame_reader is off by default.
- `handlers/variants.test.ts` (+1) and `orchestrator.test.ts` (+1): the caption change, and the caption branch's no-generation chain.
- Existing: `gate-measures.test.ts`, `runtime-wiring.test.ts`, `production-ports.test.ts`, `media-link.test.ts`.

### Owner must run live (agents hold no keys)

1. HyperFrames: set `render_hyperframes_cloud` in `config/prices.ts`, then render one composition through production `render`. Record the
   render id, the ledger row (estimate and actual), the integrity checks and the video URI.
2. Shotstack: set `MEDIA_LINK_SECRET` (32+ characters) and `APP_URL` (https). Record one signed link, and its fetch by Shotstack.
3. Detectors and frame_reader on one real MP4: black frames, silence, overlays. Record the frame_reader ledger row.
4. `media_functions` base URL: no deployment source exists yet (see blockers). Until one is set, every detector, picture and frame call is
   NOT_CONNECTED.

### Blockers for the lead

- Item 3 (above): keep deferred, or design it.
- The `media_functions` base URL: which deployment setting carries it. The gateway's `providers` option is the place; no env read is allowed in
  `src/engine`.
- `routeTree.gen.ts`: run `npm run dev` or `npm run build` once, then commit the regenerated route tree.

## E4 and E5 orchestration (branch `eng-e45-orchestration`, from `origin/code/beautiful-cori-1zfk11` at d5a62c1)

Lead task: consolidate orchestration so a request runs from intake to deliver on fixtures. Committed on the branch, not pushed; the lead
merges. Migration `migrations/0081_engine_orchestration.sql` (after 0080). Scenario tests run on PGlite with recorded responses.

### Done

1. **Migration 0081.** `engine_decisions.decided_by` allows `editor` (contract v4). `engine_role_calls.role` gets a check equal to
   `CLAUDE_ROLES` (`frame_reader` included). No SQL role check existed before; the list is the contract's, and `migration-0081.test.ts`
   reads the constraint back from `pg_constraint` and compares it with the contract.
2. **Gate routing by gold sets (orchestrator.ts).** `pre_render_gate`, `render` and `post_render_review` call
   `decideGate(gate, state.gateMetrics)` (review/gold.ts, review/STATUS.md decision 5):
   - pass: the next stage is queued, as before.
   - block (a failing check has gold metrics that meet the target): redo the named shots, or redo the EDL (compose) for a gate with no
     shot. Unchanged routing, now reached only for proven checks.
   - review (no failing check is proven): the branch escalates. The request pauses and the review item carries a
     `meridian.gate_review/v1` payload (`gateReviewItem`) for pre and post. Render integrity has no gate-review item; it carries its rules.
   - `gateMetrics` come with the start event (`startEngineRequest({ gateMetrics })`) and are kept in the request state. Absent metrics
     (or a state written before E4) prove nothing, so every gate failure reviews. Fail closed.
   - `render` outputs may carry `decisions` (the Shotstack fallback); the orchestrator stores them in `engine_decisions`.
3. **Registry and slots.** `registry.ts` reads: `compose` (edl, validated_request); `pre_render_gate` (composition, edl, scene_plan,
   validated_request, voice_track, video_dna, take); `render` (composition, edl, validated_request); `post_render_review` (rendered_video,
   edl, gate_result); `variants` (production_request, scene_plan, edl). The orchestrator passes the matching slots: `branchSlots(state,
   branch)` (accepted takes included) and `variants: [edl:<master>, request, plan]`.
4. **Compose and render stages (new handlers).** `handlers/compose.ts` compiles the EDL with the style kit and writes a `composition`
   artifact. `handlers/render.ts` recompiles, checks the composition's contentHash, then runs `renderWithFallback` (HyperFrames twice,
   Shotstack for a component-free EDL, else review). It stores the measured integrity gate (slot `integrity:<edl>`, a `gate_result`) on every
   run and the `rendered_video` (slot `render:<edl>`) on a pass. A render price that is not in the table fails the integrity gate
   (`render_price_known`), so nothing is rendered unpriced. Shotstack without deps is a failed attempt (not a success), which reviews.
5. **Event store.** `event-store-sql.ts` (`sqlEventStore`) implements `events/store.ts` on `engine_events`, with the workspace's dedupe
   key. `list` returns the learning kinds only; the orchestrator's own log rows (`stage.succeeded`, `resume`, ...) are not returned.
6. **Manifests.** `manifest-store.ts` writes `engine_manifests` rows: id = the manifest artifact's id, body, content hash, write-once (a
   different body under the same id is refused), organization-scoped. `deliver.ts` writes the row after the artifact. `engine-reads-sql.ts`
   gives deliver the gate results and decisions the orchestrator stored.
7. **Registration (runtime.ts).** Always: `pre_render_gate`, `compose`, `variants`, `deliver` (kit store, engine tables, reservation
   ledger). With ports: `render` (`composition.render`: HyperFrames and Shotstack deps) and `post_render_review` (`composition.postRender`).
   New composition fields: `styleKit`, `preRender` (budget, licences, product imagery, disclosure), `render`, `postRender`, `variants`,
   `deliver`. Production gives no `render` or `postRender`, so the pipeline stops at render with `not_implemented`, which fails closed.
8. **Output validation.** `validate.ts` checks a render's `decisions`.

### Not built: the generation variant sub-graph (lead item 3, second half)

Hook, product, persona and language variants are still reported as `deferred` by the variants stage, with no job and no ledger row. The
sub-graph is not scheduled, and this is a decision for the lead, not a gap in the tests. What it needs, in order:
- A voice job per variant for its changed beats. The voice stage is per request and has no beat-scoped job.
- A produce job per changed shot with the variant's own inputs (new hook text, product SKU, persona). The produce handler takes its
  prompt from the plan, and no variant source exists for a new prompt or a product reference.
- A variant branch in the orchestrator's state with its own shot and take map. Shots are keyed by plan shot id, which a variant would reuse.
- An `edit` for the variant EDL, then compose, pre-render, render and review as for the master.
- Until those exist, a scheduled generation variant could only fail. Scheduling it now would charge generation with no path to finish.

### Decisions to confirm (lead)

- **Render integrity goes through `decideGate` like the other gates.** A failing integrity check has no gold set, so it reviews. HyperFrames
  and Shotstack retries are inside the fallback policy and happen before the gate.
- **The take gate keeps its verdict-driven redo.** `check_take` redoes on the Critic's action, as Bible 5.3 says. Only the three render
  gates are routed by gold sets. Lead to confirm.
- **A caption variant is a no-op on the chain fixture.** Every caption clip overlaps the presenter, and the editor's face rule keeps the
  band, so `caption:*` reports `not_built: no_change`. The caption-only acceptance is tested with a music re-render variant instead:
  no generation, one composed variant. The music track comes from `VariantPorts.loadMusicTrack`, which production leaves empty, so no
  music variant is built in production.
- **Pre-render gate results in two tests are the test's own answers.** The redo and the coded-shot block answer `pre_render_gate` with a
  failing gate (the clean chain cannot produce those failing checks). The downgrade answers it with a passing gate, because the chain
  fixtures have no EDL rebuilt from the downgraded plan. Each test says so in its comment; everything after them is the real handler.
- **Stored state.** `gateMetrics` is stored in the request's state JSON. Metrics that change later do not affect a running request.

### Tests (this worktree, PGlite)

- `NODE_ENV=development node --experimental-strip-types --test 'src/engine/jobs/*.test.ts' 'src/engine/jobs/handlers/*.test.ts' 'src/engine/deliver/*.test.ts' 'src/engine/events/*.test.ts' 'src/engine/variants/*.test.ts'`: 390 pass, 0 fail.
- `orchestrator.test.ts`: 46 pass. Four E3 tests now prove their failing checks (they expected a redo for an unproven failure). Six new E4
  routing tests: an unproven pre-render failure reviews, an unproven overlay never reaches deliver, a proven post-render failure redoes,
  an unproven integrity failure reviews, the metrics are kept, and a render fallback decision is effected.
- `scenarios.test.ts` (9): E4 clean pass (manifest, reservation released), one redo, downgrade (decision recorded in the manifest), human
  escalation (gold label, resume), broken overlay (never delivered), five coded shots blocked before render. E5 music re-render variant
  (no generation job added), Shotstack fallback on a component-free EDL (decision, integrity pass, request matches the script), and a
  component EDL with HyperFrames failing goes to review with no Shotstack request.
- `event-store-sql.test.ts` (5), `manifest-store.test.ts` (4), `migration-0081.test.ts` (4), `handlers/compose.test.ts` (3),
  `runtime.test.ts` (4).
- `npm run typecheck`: exit 0. `npm run lint`: exit 0 (0 errors; the four warnings are the pre-existing ones in `src/components/`).
- The full `npm test` was not run here, as the lead asked.

### Owner must run live (agents hold no keys; nothing here calls a provider)

1. Apply `migrations/0081_engine_orchestration.sql` on PostgreSQL after 0080. Expected: it applies; the two check constraints name `editor`
   and the eleven roles. Run the new tests with `MERIDIAN_PG_TEST_URL` set: `src/engine/jobs/scenarios.test.ts`,
   `event-store-sql.test.ts`, `manifest-store.test.ts`, `migration-0081.test.ts`.
2. HyperFrames: set `render_hyperframes_cloud` in `config/prices.ts` (it is `null` now, so every render fails the price check). Then render
   one real composition through `createRenderHandler` with the HyperFrames deps. Record the render id, the ledger row (estimate and actual),
   the integrity gate's checks (resolution, fps, duration, audio) and the video URI.
3. Shotstack: force a HyperFrames failure on a component-free EDL (for example a bad composition) and record the Shotstack POST body, the
   render id, the ledger row (`shotstack`, `edit-v1`, the actual, or the hold with `actualIsEstimate`), the integrity gate and the decision.
   Record whether a retried POST bills twice (render/STATUS.md item 5).
4. Post-render: one real MP4 through `post_render_review`. Record the Critic's model and its ledger row, the black-frame, overlay and OCR
   measurements (no measurement exists yet, so every overlay and caption check is not evaluated and the video reviews), and the review result.
5. Gold sets: until a check's metrics meet the target (12.4), every gate failure reviews. Nothing blocks on a guess.

### Blockers (for the lead)

- The generation variant sub-graph (above). Lead decision: build it, or ship E5 with generation variants deferred.
- Production wiring for `render` and `post_render_review`: the gateway transports, the object store as a media store, the media functions
  (probe, frames, loudness, timeline), the HyperFrames adapter options, and the integrity probe. None is composed in
  `productionEngineRuntime`.
- Shotstack needs a signed https URL for each media URI (`resolveSourceUrl`). No storage port provides one, so the fallback cannot run in
  production yet.
- The W4 measurements (black frames, overlays, OCR) are optional ports. Without them no video passes post-render.

## E3 integration pass (branch `eng-e3-wiring`)

Built on `origin/code/beautiful-cori-1zfk11` (the E3 branches and the router's submit and settle, merged in commit d5b78f7). Nothing is
pushed. The lead merges. The lead's eight items, and the later note on the async router, are below in order.

### What is wired

1. **Pre-flight hold (lead decision 1).** Intake reserves `budgets.fixedPerMasterUsd` with `reserveFixed` after its own checks pass. The
   hold's id is `preflightReservationId(requestId, attempt)`: a retry of the same job gets the same hold, and a resume after a budget
   pause gets a new one (a paused hold is never revived). `estimate_reserve` raises that same reservation with `extendForPlan`
   (`extendReservation`); it never makes a second one. A paused or refused hold, or a workspace month that is not connected, pauses the
   request with the reason (`budgetPause`, a new intake output field). A rejected intake releases its hold.
2. **Classifier (lead decision 2).** Intake classifies the `must` requests only, with `classifyVisualRequests`, on the hold. The plan
   classifies all requests. When every request is a `must` the two inputs are identical, so the plan resumes intake's stored answer
   through the role-call journal and pays nothing twice.
3. **Workspace monthly budget (lead decision 3).** `productionEngineRuntime(sql)` reads it with
   `workspaceBudgetFromSettings(meridianMonthlyBudgetReader(sql))`. Unset, intake pauses and estimate refuses, each with the reason.
4. **Edit inputs (lead decision 4).** `registry.ts` gives `edit` the read `validated_request`; `nodeSlots.edit` passes `validated`. The
   style kit comes from the kit store at the exact version the validated request names (`loadStyleKit`). Music is not connected, so
   `loadMusic` is absent and the editor's no-music path runs.
5. **Plan lease (lead decision 5).** `plan` has `timeoutFactor: 3`, so its lease is three Claude leases (360 s). **Config request for
   the lead:** add `thresholds.jobs.leaseMs.plan` (360 000 ms) and drop the factor.
6. **Director beat text (lead decision 6).** `DirectorChoice.beatText` carries the beat's script text from `plan/build.ts` to
   `director_check`, which accepts it as untrusted data. The director prompt is now `director_check@2.md` (the table description
   names `beatText`); `director_check@1.md` is kept as shipped and pinned. The planner never receives script text. The director's prompt
   edits are still refused when they ask for text.
7. **Composition root (lead decision 7).** `runtime.ts`: `createEngineRuntime(composition)` and `productionEngineRuntime(sql)`.
   Registered always: `intake`, `plan`, `estimate_reserve`, `edit`. Registered with their ports: `produce_shot` and `check_take`
   (`shotPorts`: media functions, object store, asset-media store, optional similarity scorer), `analyze_reference` (`analysis`
   ports) and `voice` (`voice` ports). Not registered anywhere: `compose`, `pre_render_gate`, `post_render_review`, `variants`,
   `deliver` (not built) and `render` (no stage handler exists; the W10 adapter is not wired to a stage). Production passes no
   `shotPorts`, `analysis` or `voice`, so those stages stay `not_implemented`, which fails closed. Production passes no
   `lookupDna`, so intake fails its `dna_lookup_resolved` check until a lookup exists.
   `lib/meridian/jobs/execute.ts` calls `executeEngineJob(sql, job, productionEngineRuntime(sql))`. Nothing reads `process.env`.
8. **End to end (lead item 8), `e2e.test.ts`.** Two cases on PGlite, each in its own database, each using the fixture request id (the
   recorded planner answers name shot ids derived from it).
   - Case 1 (budget $0.52, the fixed cost): intake (classifier on the hold), analyze and voice (stand-ins), plan (recorded planner and
     director), estimate (the same hold, extended to 0.52), three stock produce jobs, three check jobs. The take gate escalates each take
     (no black-frame, flicker, motion or similarity measurement), so the request pauses for review with an escalation item. The test
     asserts one hold for the request, one ledger row per answered Claude call on that hold, and no ledger row on any other reservation.
   - Case 2 (budget $4): the same flow to estimate. The fixture plan's first shot is Avatar IV (`ugc_presenter`), which is not connected,
     so its produce job dies on its last attempt, the request pauses on that shot (`dead_letter`), and no avatar call is charged.
   - **Not reached: the EDL.** See Blockers.
9. **Async produce (the lead's later note).** `routerGenerator` calls the router's `submit`. A submitted call returns `submitted` with
   its `AssetJob` as the poll's carry, together with the router's decisions so far. The poll's `finish` calls `settle(job, polled)`. If
   settle moves the call to its next target, `finish` returns `submitted` again and the poller queues the next poll. A provider failure
   (any kind, including a refusal) and a poll timeout both reach `finish` as a failed poll state. A timeout is cancelled first if the
   adapter can cancel it. The poller no longer throws for a provider failure: the router decides between a fallback and a failure.
   **One downloader:** the handler's `gatewayDownloader` takes every take. The router's `takes` downloader is not set, so no take is
   downloaded twice. `ProviderResolver.resolve(providerId, organizationId)` returns the poll adapter the router would build for that
   route and workspace (`pollAdapterFor`, from the gateway's route table). The router's `waitMs` (`runAfterMs`) is not used: the poll
   keeps its own backoff.

### Decisions and deviations (for the lead to accept or reject)

- **Kits are not artifacts.** The artifact types have no kit type, and an artifact belongs to one request while a kit belongs to a
  workspace. Kits are rows in `engine_kits` (Bible 5.4) and are read by `kit-store.ts`, with the same tenancy. Making kits artifacts is a
  contract change (`ARTIFACT_TYPES`), which needs approval.
- **A budget below the fixed lines is refused before any hold** (`budget_covers_fixed_lines`). A budget between the fixed lines and the
  minimum is refused after the classifier, with the hold released. That costs one classifier call (a fraction of a cent) before the
  refusal; the minimum needs the classification.
- **Intake's classifier and the plan's classifier are separate calls** unless the inputs match (see item 2).
- **`ProviderResolver.resolve` takes the workspace.** Adapters carry the workspace's credentials.
- **Poller:** a non-refusal provider failure is settled, not thrown (the existing tests assert the new behaviour).
- **`StageHandler.finish` returns a `StageRunResult`** (done or submitted again), not a `StageOutput`.
- **Stand-ins in `e2e.test.ts`.** `analyze_reference` and `voice` write their contract fixtures, and their gates say so
  (`recorded_stand_in`). The real handlers exist on this branch now, but their ports need full media functions, a speech-to-text
  connection, a TTS route and the role deps. Those are not wired in production or in the test, so the test does not exercise them.

### Blockers (on recorded fixtures)

- **No EDL is reachable from honest inputs on this branch.** Two reasons. (a) The take gate needs black-frame, flicker, motion and
  similarity measurements, which have no media function or vendor, so every take escalates (Bible 12, 12.4). (b) The fixture plan's
  generated shot is Avatar IV, which is not connected. Its only cheaper alternative is the all-code plan at the fixed cost, and that plan
  still checks stock takes, so (a) applies. The E3 acceptance cannot pass until the measurements exist.
- **The planner's answer is tied to the request's shot ids,** so a plan variant (for example a page with no presenter) needs a new
  recorded answer. Changing the page without one would be a fabricated answer.
- **`render` has no stage handler**, and `compose` is not built, so nothing reaches a render.
- **Production wiring not done:** the media functions' base URL and the object store (both needed for `produce_shot` and `check_take`),
  the VideoDNA lookup, and the speech-to-text and TTS connections for analyze and voice. Each of these fails closed until it is wired.

### Owner must run live

Nothing here calls a provider. For the live run, after the lead merges: set the workspace's monthly video budget in Settings; seed the
kits in `engine_kits` (or through the kit store); wire the media functions, the object store, the VideoDNA lookup and the STT and TTS
connections; then run a request at $0.52 and record each stage, the hold's id, its ledger rows and the take verdicts. The live run is
the E3 acceptance and needs the take measurements first.

### Checks on this branch

- `NODE_ENV=development node --experimental-strip-types --test 'src/engine/jobs/*.test.ts' 'src/engine/jobs/handlers/*.test.ts' 'src/engine/plan/*.test.ts' 'src/engine/claude/**/*.test.ts' 'src/engine/prompts/*.test.ts'`: 466 pass, 0 fail (PGlite).
- Boundary and config tests (gateway, review, media, config, assets, claude): 103 pass, 0 fail.
- `npm run typecheck`: exit 0. `npm run lint`: 0 errors, 4 warnings (the existing UI files).
- The full `npm test` was not run here, as the lead asked.

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
