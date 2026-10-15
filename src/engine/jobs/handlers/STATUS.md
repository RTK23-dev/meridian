# STATUS: intake and estimate_reserve stage handlers (A4, updated in E2)

## Chains on produce_shot and check_take (contract v5; branch `worktree-agent-a2631ad1048c21356`, from `cef526c`)

There is no `produce/` folder: the produce_shot handler is `produce-shot.ts`, so its status is here. The plan side is in `../../plan/STATUS.md`.

**produce_shot: a chain makes its calls in order (`produce-shot.ts`, Bible 7.1, contract v5)**

- A shot whose source is a chain runs its calls one after another. Each call is one generation on the request's reservation, with its
  own spec: the spec id, the seed and the cache key (the input hash, `assetCacheKey`) all name the call (its shot, attempt and output name).
  The router writes the call's ledger entry on submit, so each call has its own entry. A paid call that comes back with no ledger entry
  is an internal error, and the chain stops there.
- A call's inputs are resolved before it is made: an asset is its uri; an output is the uri the earlier call made. An output that no earlier
  call made is an internal error (the schema already refuses it at parse time).
- A call that is submitted returns `submitted`, with the chain's progress on the carry (`carry.chain`: the next call's index, the start time,
  and each finished call's output, its ledger entry, its prompt hash and its cost). The poller's `finish` settles the call, rebuilds its
  spec from the same outputs (the router refuses a settle whose spec differs), and carries on with the calls that follow.
- A refused call (budget) or a failed call (content policy, invalid input) stops the chain. No later call is made. The hold names the call
  (`clip: <reason>`), the refusal keeps its hint, and a decision records the stop (Bible L7).
- **Cartoon** (`cartoon_generated`): the last call is a video, so the shot's take is that clip (downloaded, probed and stored like any take).
  Its cost is the sum of both calls, and its provider and model are the clip's.
- **Stop-motion** (`stop_motion`): the last call is an image, so there is no take. The output names the closing component
  (`stopmotion.player`) in a decision, and holds no take and no hold. The stage's outputs are: `takeId: null`, no `hold`.
- **Before the first call:** the closing component must be drawn (`componentHas`, default: the component library). A stop-motion chain
  whose player is not drawn throws `config` and makes no call, so no frame is paid for.
- `produce-shot.ts` exports `chainCallSpecFor`, `chainProgressSchema`, `chainOutputSchema`, and the types `ChainOutput` and `ChainProgress`.

**check_take**

- A chain's take is generated, so the motion check applies (`motionRequiredFor` counts `chain`). The rest of the check is unchanged.

**edit: not changed (blocked, see below)**

- The edit handler passes every take to the editor. The editor (`edit/editor.ts`, not in this task's grant) treats only `generate` and
  `stock` as media shots, so a chain take fails `takes_match_plan`, and a chain shot with no take passes `shot_sources_available` (the
  shot is not required to have one). Both must change before a chain reaches edit: one predicate that includes `chain` in both places.

**Blockers outside this grant (the lead decides; see `../../plan/STATUS.md` for the full list)**

1. `jobs/handlers/plan.ts` `shotSummaryOf` refuses a chain (`notImplementedError`), so a plan that picks cartoon_generated fails the plan stage.
2. `jobs/types.ts` (`ShotSourceKind`), `jobs/orchestrator.ts` (`needsProduce`, `providerKeyFor`, `applyProduce`): a chain is not a
   produce shot, and a takeless output with no hold is refused by `applyProduce`.
3. `edit/editor.ts` media rule (lines 136 and 162), above.
4. Not checked here, but they test `source.kind === "generate"` for paid generation and need `chain` before a chain plan runs:
   `variants/expand.ts` (line 134), `deliver/manifest.ts` (line 110). `review/gates/plan.ts` and `review/slideshowRisk.ts` already treat a chain as generated.
5. Adapters (`assets/providers/openrouterImage.ts`): the image adapter refuses any reference or frame ("image models take no references or
   frames in this adapter; no call is made"), so the keyframe (character references) and every image.edit frame would be refused live.
   The video adapter needs an https first frame (`normaliseHttpsUrl`), and the keyframe's uri is a store uri. Both are the same questions
   product_hero already has with its hero frame, and the live run answers them.
6. Frames are not stored as artifacts. Their uris live in the job's carry until the job ends, and no artifact type holds a chain output.

**Tests (this section)**

- `produce-shot.test.ts`, the `a chain of calls on the produce_shot stage` block (8 tests, on PostgreSQL with recorded answers): the cartoon
  chain makes the keyframe, then the clip from it, and one take that costs both calls; each call has its own input hash, and a paid call
  with no ledger entry is an internal error (a cache hit with none is not); a second call refused for the budget stops the chain with its
  reason and makes no further call, with nothing downloaded; a stop-motion chain with a fake price (the overlay) makes 30 frames in order,
  each with its own key, then names the player and writes no take; a stop-motion chain whose player is not drawn makes no call; a chain
  whose call is submitted carries its progress, and finish settles it and makes the next call; a settled call refused by the provider stops
  the chain; the inputs resolve from earlier outputs, and an output no earlier call made is refused.
- `check-take.test.ts`: a chain shot's take must move (the motion check applies); a chain take runs through the stored-take path and the
  motion check is in its verdict.

Run: `NODE_ENV=development node --experimental-strip-types --test src/engine/jobs/handlers/produce-shot.test.ts src/engine/jobs/handlers/check-take.test.ts src/engine/jobs/handlers/edit.test.ts`
Result: 47 tests in those three files pass, 0 fail (before this change: 37; produce-shot 21 to 29, check-take 8 to 10, edit 8).
The whole handlers folder (`src/engine/jobs/handlers/*.test.ts`) runs 138 tests, 138 pass, 0 fail.

**The owner's live run (agents hold no keys)**

1. With the orchestrator and the plan handler accepting chains (blockers 1 and 2) and the editor's media rule fixed (blocker 3): one
   cartoon_generated beat on a page with a generated character sheet. Record the keyframe's call and ledger entry, the clip's call and
   ledger entry (the cache key of each), the take artifact id, its cost (the sum of the two) and the check_take verdict.
2. The same beat with a refused keyframe (content policy) to see the stop and the planner's one rewrite, with the hold reason.

## W2 leftovers: wiring pass (branch `eng-e45-leftovers-2`; the full account is `../STATUS.md`)

Not run: no tests, typecheck or lint in this pass (owner instruction).

- **`check-take.ts`.** `CheckTakePorts.detectors` (`TakeDetectors`: black, flicker, motion) gives the take's measurements through
  `takeMeasurementsFromDetectors` (`../gate-measures.ts`). Precedence: `measure`, then `detectors`, then the probed values (all null,
  so missing evidence). Each detector's `invalid_input` is a null measure; other errors throw. Tests: `check-take.test.ts` (+2).
- **`post-render-review.ts`.** `PostRenderPorts.detectors` (black frames and silence) through `renderMeasuresFromDetectors`. The silence
  comes from the detector when it is wired, otherwise from the timeline. `frameReader: true` reads overlays through the frame_reader role
  at each graphics clip's midpoint (`overlaysFromFrameReader`, off by default). `measureBlackFrames` and `measureOverlays` win when given.
  OCR is still undefined. Tests: `post-render-review.test.ts` (+7).
- **`render.ts`.** `RenderPorts.renderEstimateUsd(scope, durationMs)`: the render line is priced for the video's length (per minute).
- **`variants`.** Caption-fixture test in `variants.test.ts` (the captions change for real); the orchestrator's caption branch test is in
  `../orchestrator.test.ts`. Generation variants are still deferred (see `../STATUS.md`).

## E4 and E5 (branch `eng-e45-orchestration`; the full account is `../STATUS.md`)

- **`compose.ts`** (new, Bible 6.9). `createComposeHandler({ loadStyleKit, now })`. Reads the `edl` and the `validated_request`, compiles
  the EDL with the style kit (`compose/compiler.ts`), and writes the `composition` artifact (slot `composition:<edl>`). Pure. A kit that did
  not load, an EDL the compiler refuses, or a missing input is `invalid_input`. Covered by `compose.test.ts` (3).
- **`render.ts`** (new, Bible 6.11, owner decision 2026-10-14). `createRenderHandler(ports)`. Reads the `composition`, the `edl` and the
  `validated_request`; recompiles and checks the contentHash; runs `renderWithFallback` (`render/fallback.ts`) with the HyperFrames deps
  (`renderComposition`) and, when the composition root gives it, the Shotstack deps (`renderEdlWithShotstack`). Every run stores the
  integrity gate (slot `integrity:<edl>`); a pass also stores the `rendered_video` (slot `render:<edl>`). The integrity gate is recorded
  as the renderer's own check returned it (a wrapper keeps it). A Shotstack route is a `decisions` entry (`chose` shotstack, `by` scorer).
  Review is a failing gate with rule `render_completed`. A render price of `undefined` fails `render_price_known`. Shotstack without deps
  is a non-retryable provider error, which counts as a failed attempt. Tested in `scenarios.test.ts` (fallback and review) with a
  scripted HyperFrames adapter that fails on submit and the shotstack harness.
- **`pre-render-gate.ts`** (registered, E4). Unchanged. Its `loadStyleKit` is the composition's `styleKit` (or the kit store); the optional
  ports come from `composition.preRender`. Absent, their checks are not evaluated and the gate reviews.
- **`post-render-review.ts`** (registered when `composition.postRender` is given, E4). Unchanged.
- **`variants.ts`** (registered, E5). The orchestrator now passes the request and the plan with the master (`request`, `plan`,
  `edl:<master>`). Production has no music track connected, so `loadMusicTrack` returns undefined and no music variant is built. The
  generation variants are still `deferred` (see `../STATUS.md`, the sub-graph).
- **`deliver.ts`** (registered, E5). Writes the `engine_manifests` row for each manifest (`../manifest-store.ts`) after the artifact write,
  under the same id, so a retry writes nothing twice. The stage reads the gate results and decisions from `engine_gate_results` and
  `engine_decisions` (`../engine-reads-sql.ts`).
- **Tests added:** `compose.test.ts` (3), and the orchestrator's gate-routing tests in `../orchestrator.test.ts`. The end-to-end
  scenarios (`../scenarios.test.ts`, 9) and the runtime registration test (`../runtime.test.ts`, 4) cover the rest.

## E3 integration pass (branch `eng-e3-wiring`; the full account is `../STATUS.md`)

- **`intake.ts`:** reserves the pre-flight hold (`reserveFixed`, id from `preflightReservationId`) after the request's own checks pass,
  classifies the `must` requests on that hold (`classifyVisualRequests`, through `roleDeps` with the request's journal), and runs the
  final gate. A pass keeps the hold; a rejection releases it. A paused hold or an unconnected month returns `budgetPause`, which the
  orchestrator turns into a budget pause. New checks: `budget_covers_fixed_lines` (before any hold), `requests_classified`.
  Ports: `loadKits`, `lookupDna?`, `workspaceBudget?`, `roleDeps?` (scope now includes `reservationId`).
- **`estimate-reserve.ts`:** extends the intake hold (`extendForPlan`, which is `extendReservation`). It makes no second reservation.
  No hold on the payload, or an unconnected month, refuses with the reason. `WorkspaceBudgetSource` and `WorkspaceMonthBudget` live here.
- **`plan.ts`:** `roleDeps` takes `{ organizationId, requestId, reservationId }`, so the request's journal and the hold's ledger are used.
- **`produce-shot.ts`:** the router's `submit` and `settle` (see `../STATUS.md`, item 9). One downloader, this handler's.
- **`register.ts`:** unchanged. `runtime.ts` (in `../`) builds the set.
- **Tests:** `intake.test.ts` (21, PGlite: a classifier call on the hold, the fixed-lines refusal, a paused month, no monthly source,
  no classifier, a released hold, and the same hold on a retry), `estimate-reserve.test.ts` (extension, cap pause, unknown price,
  not-found, and the PGlite handler cases), `produce-shot.test.ts` (submit carries the job; settle may submit again).

Branch `eng-a4-budget-minimum`, cut from `code/beautiful-cori-1zfk11`. E2 changes on `eng-e2-pipeline`: the estimate_reserve
budget source and request input, and the intake comment. The format minimum is in `src/engine/plan/minimum.ts`.

## E2 changes (current behaviour; the blockers below are updated where E2 answered them)

- **Intake** no longer reserves, and the orchestrator no longer pauses on its null reservation. Intake returns
  `budgetReservationId: null` on a pass. The paid stages before estimate_reserve pause the request on budget, naming the first
  one (see `../STATUS.md`, item 1). Blocker 1 below is still open for the lead.
- **estimate_reserve** reads the `production_request` artifact too (the registry and the orchestrator pass it). The request
  budget is `constraints.budgetUsd`, so `EstimateReservePorts.budgets` and `BudgetPort` are gone.
- **Monthly budget**: `WorkspaceBudgetSource.monthBudget(scope)` returns `{ status: "known", usd }` or
  `{ status: "not_connected", reason }`. The default, `notConnectedWorkspaceBudget`, is not connected, so the stage refuses to
  reserve with that reason and stores nothing. A NaN or negative amount is refused too. Blocker 3 is still open: the owner
  decides where the budget is set (Bible 20.2).
- Blocker 2 (the request budget had no input) is answered by the registry change.
- Tests: `estimate-reserve.test.ts` 14 pass (PGlite and in-memory), including the not-connected refusal, unusable amounts, and a
  missing `production_request` input. The "request artifact does not parse" case is not tested: `writeArtifact` refuses an
  invalid body, so no such artifact can be stored; the handler's parse check is defensive.

## Done

- `intake.ts` (Bible 6.1, gate `request` 12.1). `decideIntake(input)` is pure: the request gate with the format minimum from
  `minimumMasterBudgetUsd`. A budget below the minimum fails the gate, and the gate's detail reads
  `budget X USD is below the minimum Y USD`. `createIntakeHandler(ports)` reads the production_request artifact, calls the
  ports, and writes the validated_request artifact (parent: the request artifact) only when the gate passes.
- `estimate-reserve.ts` (Bible 6.5, 14.1). `reserveForPlan(store, input)` is pure over `LedgerStore`: reserve() in cap mode,
  then `checkBudget`. `createEstimateReserveHandler({ budgets })` reserves under `withWorkspaceLedger`, then writes the
  budget_reservation artifact (parent: the plan artifact).
- Reservation id: `planReservationId(requestId, planArtifactId)`, a sha256 digest in ULID form. A repeated job gets the same id
  and reserve() returns the stored reservation.
- Paused (cap mode): the gate fails, the output has `budgetReservationId: null`, and the paused reservation is stored with its
  reason. Unknown price: the gate fails, the shot is named, and nothing is stored.
- Tests: `intake.test.ts` 11 (pure cases, plus the handler on PGlite), `estimate-reserve.test.ts` 11 (in-memory store, plus the
  handler on PGlite). Outputs are checked with `validateStageOutput`.
- `npm run typecheck`: exit 0. `npm run lint`: 0 errors, 4 warnings in existing UI code.

## Ports the worker must supply (not wired here; each fails closed without it)

- `IntakePorts.loadKits` (required): the style, persona, voice, character and product kits. No engine kit reader exists yet.
- `IntakePorts.lookupDna` (optional): the VideoDNA lookup (6.1 step 5). Absent, the gate's `dna_lookup_resolved` fails.
- `IntakePorts.classify` (optional): the 7.3 classifier (a Claude Haiku role, not built). Absent, every `must` fails its check.
- `EstimateReservePorts.workspaceBudget` (E2): the workspace monthly budget. Absent means the not-connected default, so nothing
  is reserved. The request budget comes from the production_request artifact.

## Blockers for the lead (decisions, not built here)

1. **The pre-flight reservation.** A passing intake returns `budgetReservationId: null`. `orchestrator.ts` `applyIntake` then
   pauses the request on budget ("intake passed without a budget reservation"). So no request runs past intake. The paid
   stages `analyze_reference` and `voice` run before any plan exists, and dispatch refuses a paid stage with no reservation.
   The jobs README asks intake for a pre-flight reservation. Options: (a) intake reserves the minimum's lines through the
   ledger, and estimate_reserve releases that hold with `releaseReservation` once the plan's reservation exists; (b) another
   design. I did not build (a). It holds money, and the amount and the release are the lead's call.
2. **estimate_reserve has no request budget.** `registry.ts` gives it only `scene_plan`, and `orchestrator.ts` passes only the
   `plan` slot. `engine_requests` has no budget column. Fix: add the `validated` slot to estimate_reserve's reads and to
   `nodeSlots` (a W2 change), or store the budget on the request row.
3. **No workspace monthly budget exists in Meridian.** A grep of `src/lib/meridian` found none. It needs an owner decision and a
   place to be stored. Until then estimate_reserve refuses to reserve.
4. **VoiceKit has no words-per-minute.** Intake takes the speech length from `Persona.wordsPerMinute`. A page with no persona
   therefore cannot pass intake (fail closed). Fix: a contract field on VoiceKit (W1, with lead approval).
5. **The classifier and the kit store are not built.** Until they are, intake refuses every request with a `must`, and every
   request whose kits do not load.

## Notes

- The handler adds three checks to the request gate's list: `speech_length_estimated`, `format_minimum_computed` and
  `validated_request_built`. They are handler-level and are not in the gate's own RULES list.
- When the validated request cannot be built, the gate returns its "not evaluated" checks for the rest. The handler's
  checks name the cause (a kit that did not load, or no words per minute).

## E3: the edit stage (`edit.ts`, `edit.test.ts`)

Branch `eng-e3-editor`. `createEditHandler({ loadStyleKit, loadMusic? })` runs the editor in `src/engine/edit/` (see its STATUS.md).
It reads the scene plan, the video DNA, the voice track, the validated request and the accepted takes, and writes the `edl` artifact
on a pass (parents: every input, slot `edl:<edlId>`). A fail writes nothing and returns the `edit` gate with its checks and failing
shots. Missing or foreign inputs are `invalid_input`. A style kit that does not load, or is not the version the request names, is a
gate fail (`style_kit_loaded`), so nothing runs on a guessed look.

- `edit.test.ts`: 8 pass on PGlite. The handler builds the EDL and writes it with the inputs as parents; the same inputs give the
  same EDL id and content hash across runs; a missing validated request and a foreign plan are refused; a missing kit and a kit of
  another version fail the gate and store nothing; a generated shot with no take fails and names the shot; a music port places
  the music under the speech.
- Needs from W2 (not made here): `registry.ts` must give `edit` the read `validated_request`, and `orchestrator.ts` `nodeSlots.edit`
  must pass it. Until then a live edit is refused with `invalid_input`. The worker must also supply `loadStyleKit`.

## E4: pre_render_gate and post_render_review (branch `eng-e4-gates`)

- `pre-render-gate.ts` (`createPreRenderGateHandler`, Bible 6.10, 12.3): reads the composition, the EDL, the plan, the validated
  request, the voice track, the video DNA and the takes; refuses a missing or foreign input; runs `checkPreRender` (review/gates/preRender.ts)
  and writes the `gate_result` artifact on every run. Ports: `loadStyleKit` (required), and optional `renderBudget`, `licensedUris`,
  `productImageUris` and `disclosures`. Absent ports fail their checks (review). Unpaid.
- `post-render-review.ts` (`createPostRenderReviewHandler`, Bible 6.12, 12.3): reads the rendered video, the EDL and the render stage's
  `render_integrity` gate result when one is an input. Measures the file (loudness, timeline, frames) through `MediaFunctions`, takes the
  optional measurement ports (black frames, overlays, OCR), runs the final Critic through `runCriticFinal` on the request's reservation (paid),
  runs `checkPostRender`, and writes the `review_result` artifact on every run. A frame set the media functions refuse leaves the Critic
  unanswered, and nothing is sent.
- Registry and orchestrator changes these handlers need (eng-pipeline, see review/STATUS.md decisions 5 to 7): `registry.ts` reads for
  `pre_render_gate` (scene_plan, validated_request, voice_track, video_dna, take), the render stage's integrity `gate_result` as a
  `post_render_review` input, and `orchestrator.ts` routing through `decideGate`.
- Tests: `pre-render-gate.test.ts` (7) and `post-render-review.test.ts` (13), on PGlite, with the recorded critic answers and fake media
  functions. Run with the review tests (see review/STATUS.md).

## Owner live run

None. No provider is called, and the database is PGlite only.

## E5: the variants and deliver handlers (`variants.ts`, `variants.test.ts`, `deliver.ts`, `deliver.test.ts`)

Branch `eng-e5-variants`. The logic is in `src/engine/variants/`, `src/engine/deliver/` and `src/engine/events/` (see their STATUS.md).

- `createVariantsHandler(ports)`: reads the request, the plan and the master EDL, and the reservation's headroom. Builds the caption and
  music variants as EDLs (checked against their control) and writes them as `edl` artifacts with `variantOf` set. Reports hook,
  product, persona and language variants as deferred, with their work. Emits `variant.planned` for each variant.
- E5 item 3 (this branch, partial; see `../../variants/STATUS.md`): the stage funds the variants it runs under the reservation
  (`extendForVariants`, refused with the reason above a budget). With `VariantPorts.generation` wired it prepares each generation variant:
  the writer (once for a hook or a language), the beat-scoped voice, and the variant plan (kit references). Production does not wire
  `generation`, so generation variants stay deferred with `NOT_CONNECTED`. A new port, `workspaceMonthBudgetUsd` (optional), is read for
  the raise. Tests: `variants-generation.test.ts` (11 on PGlite, recorded answers).
- `createDeliverHandler(ports)`: picks the delivered videos, settles the ledger (reconcile, then release under the reservation's lock),
  writes one manifest per delivered video under a stable id, and emits the learning events. A retry writes and emits nothing new.
- Tests on PGlite: `variants.test.ts` (8), `deliver.test.ts` (7). Both use the artifact store and check the output with
  `validateStageOutput`.
- Needs from the orchestrator (not made here, eng-pipeline's files): `nodeSlots.variants` must pass the `production_request` and
  `scene_plan` slots, and `registry.ts` must widen `reads` for `variants` (the stage refuses without them). `deliver` reads every
  slot the orchestrator passes; its registry `reads` is empty.
- Needs from the worker (not wired here): the ports. `loadMusicTrack`, `withLedger` (production: `withReservationLedger`), the event
  store (a Postgres store on `engine_events`), `roleCalls` (`listRoleCalls`), `gates` and `decisions` (the engine tables), and the clock.
- The variants stage makes no generation call and no paid call. The deliver stage pays for nothing; it reconciles and releases.
