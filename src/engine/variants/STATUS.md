# STATUS: variants (W13, phase E5)

## E5 item 3: the generation variant sub-graph (this branch, PARTIAL: not done)

Status: partly built, not done. Item 3 is not complete, because the variant's shots, its voice placement and its assembly are blocked
(list below). Every piece below is tested with recorded answers and no live call. Production does not wire the generation ports, so a
generation variant is still reported `deferred` with `NOT_CONNECTED` and nothing is charged.

Built here, and what each gap became:
- **Funding (`reserve.ts`, `extendForVariants`).** The variants that run are funded under the request's reservation before any call. The
  hold is set to the committed spend plus the funded estimates (never lowered, idempotent). A raise above the request budget, above the
  workspace month, or with the month budget not connected is refused with the reason, and nothing is written. `deliver` releases the rest.
- **Budget fit (`expand.ts`).** A variant may spend the headroom plus the room the request budget leaves the reservation (`extendableUsd`).
  A variant refused by the request budget is skipped with `over_request_budget`. The matrix budget still binds first (`over_budget`).
- **Writer (`writer.ts`).** `writerInputFor` builds the input of a hook (its hook beat, one line) or a language (every beat). The call is
  `runRole` on `variant_writer` (the check route, `prompts/variant_writer@1.md`, which already existed), so it is ledger-backed and
  journaled, and retried once. Outcomes: done, refused, not_connected, failed. The stage calls it once per hook or language variant.
- **Beat-scoped voice (`speak.ts`).** `speakChangedLines` runs the voice stage (`runVoice`, unchanged) on a request whose script is only the
  changed beats, with their new text (and the variant's language). Voice for a product or caption change is not called.
- **Variant plan (`plan.ts`).** `variantScenePlan` changes the references of the touched generated shots only (a product swap: the kit's
  front hero image; a persona: the persona's first portrait). Every other shot is the master's, and the shot ids and timing are kept. The
  plan is validated against the scene plan contract. `productReferenceOf` and `personaReferenceOf` read the kits.
- **Stage (`jobs/handlers/variants.ts`).** With `VariantPorts.generation` wired, each funded generation variant is prepared in turn: kits,
  writer, beat-scoped voice, variant plan. The plan and the voice are stored as artifacts (`plan:<key>`, `voice:<key>`), and the event is
  `deferred` with its work. A variant that fails is `not_built` with the reason, and a provider error throws (so the job retries).

Blocked (the rest of item 3). Each is a decision or a change outside this grant, not a bug in the code above:
1. **The variant sub-graph in the orchestrator.** `StageOutput`'s `variants` member carries only `edlId`s, so the orchestrator cannot learn a
   prepared variant's key or the shots it must produce, and its shots, takes and edit are request-scoped. Proposal (jobs/types.ts, one
   member, not a contract): `variants: { edlId: string }[]; prepared?: { key: string; attribute: "hook" | "product" | "persona" | "language";
   produceShotIds: string[]; planSlot: string }[]`. Then: a variant run with its own shot and take entries (a `variantKey` on `ShotState`),
   produce and check for those shots only, an `assemble` run of the stage per variant (subject = its key) that builds the EDL, and
   `deliver` waiting for every run. A variant shot's failure fails that variant alone, and it never re-plans the master.
2. **The voice segment cannot be placed.** `contracts/edl.ts` has one `audio.voice` clip, and `media/` has no audio splice (ffmpeg concat).
   Proposal (needs eng-contracts and lead approval, with a Bible section 4 note): `audio.voice` becomes an ordered list of clips, or the
   EDL gains `audio.voiceSegments`; and a media function `spliceAudio({ inputs: { uri, startMs, endMs }[] }) -> uri` in a serverless
   function. Until then a variant whose voice changes is not assembled. Product variants do not need it.
3. **The hook with a presenter.** Bible 14.3 ("presenter in hook only") re-produces the presenter for lip-sync. Implemented: a hook re-produces
   its generated shots (the handler test with the default fixture), and a hook with a coded hook beat re-produces nothing (the lead's
   literal test). The owner should confirm the presenter re-take, since a quality gate has not yet seen it.
4. **The product swap's prompt.** The reference changes, but the shot's prompt still names the master's product. Rewriting it needs the
   planner (a decision), so a product variant's take may show the wrong product text. Owner or lead to decide before a live run.
5. **Production wiring.** `runtime.ts` does not pass `variants.generation` (or `workspaceMonthBudgetUsd`). A SKU lookup for product kits
   needs a store query (`kit-store.ts` reads by kit id only). Both are the worker's composition and stay unwired (fail closed).
6. **Deliver reads one scene plan.** `handlers/deliver.ts` refuses when a request has two `scene_plan` inputs. `applyVariants` therefore
   merges only the `edl:` slots into the request's artifacts, and a prepared variant's plan and voice stay with the stage. Deliver must read
   the master plan by id before the sub-graph can use those slots.
7. **Month boundary.** A raise is refused when the run's month differs from the reservation's month (the same rule as `extendReservation`).

Tests (all `node:test`, recorded answers, PGlite for the handler, no live call):
- `reserve.test.ts` (10): raise to committed plus funded, no write when headroom covers, idempotent, refused above request budget and above
  the month with the reason, month not connected, paused, other month, not_found and bad amounts, and release at deliver.
- `expand.test.ts` (+4): a variant that fits the request-budget room, refused by the room with its reason, the matrix budget binds first,
  bad room.
- `writer.test.ts` (7): writer input for hook and language, a hook with no hook beat refused, one call paid on the reservation, a retry on a
  dropped number, both answers invalid, not connected with no call.
- `speak.test.ts` (6): the changed request, emphasis kept only when still present, language, bad lines refused before any call, the kit and
  claims handed on, and the real voice stage not connected with no call.
- `plan.test.ts` (10): product swap changes only the product shot, persona swap, hook keeps references, no-shot variant, decision and plan
  id, not-generated and not-in-plan refused, purity, the kit references.
- `jobs/handlers/variants-generation.test.ts` (11): the hook variant calls the writer once, speaks only the hook beat and queues no
  produce_shot (coded hook); a presenter hook re-produces only its shot; a product variant re-produces only the product shot; a caption
  variant queues no generation; the reservation is raised and released at deliver; a variant over the request budget is refused with
  `over_request_budget`; no month budget refuses a raise; no generation ports defers with NOT_CONNECTED; a voice not connected stops
  the hook before its plan; a persona speaks every beat in its voice and re-produces its presenter with its portrait; a stage with no
  request or plan among its inputs is refused before any call.
- `orchestrator.test.ts` (+1): a prepared variant's plan and voice are not request artifacts, so deliver's inputs hold one scene plan.
- The existing `handlers/variants.test.ts` and `orchestrator.test.ts` still pass.

Recorded answer: `test/fixtures/openrouter-variant-writer-hook.json` (the writer's line for the hook beat). Its model field is a placeholder.

Lead item 4 (a caption fixture that really changes captions): `src/engine/jobs/test/caption-variant.ts` (`captionVariantMaster`). Its caption
after the presenter moves to the variant's band, and the one over the presenter keeps its band (the face rule). `handlers/variants.test.ts`
asserts the change touches only the captions surface, and `orchestrator.test.ts` asserts the caption branch queues no produce or voice job.

Branch `eng-e5-variants`, from `origin/code/beautiful-cori-1zfk11` at 79f7a92. Covers `src/engine/variants/`,
`src/engine/deliver/`, `src/engine/events/`, `src/engine/claude/roles/variant_writer.ts` (with its test and
`src/engine/prompts/variant_writer@1.md`), and the handlers `src/engine/jobs/handlers/variants.ts` and `deliver.ts`. Nothing is
pushed. The lead merges.

## What is built

- **Expansion (`expand.ts`, pure).** The six attributes of Bible 6.13. Each planned variant has one control (the master EDL and the
  attribute, with `from` and `to`), its work, its build and its estimate (`config/budgets.ts`, the high end). The fit is cheapest
  first, then the matrix order, and it names the limit that stops each variant.
- **EDL diffs (`diff.ts`, pure).** `diffEdl` names each changed surface. `checkControl` refuses a variant that changes more than its
  attribute allows. Caption and music variants are built from the master and checked (`buildRerenderVariant`). The transforms for
  hook, persona and language (a rebuild from new inputs) and for product (`withVisualSources`) exist and are tested. The stage does
  not run the rebuild or the retake (see deferred).
- **The variants stage (`jobs/handlers/variants.ts`).** Reads the request, the plan and the master EDL, and the reservation's
  headroom (read under the reservation's lock, no entry written). Builds caption and music EDLs and writes them as `edl` artifacts,
  each with `variantOf` set to the master, parented on the master, the request and the plan. Every planned, deferred, not-built and
  skipped variant is written as a `variant.planned` event. A variant that cannot be built fails alone; the stage does not fail for it.
- **Variant writer (`claude/roles/variant_writer.ts`).** A check role (`llm.check`) on `variant_writer@1`, stage `variants`.
  Its answer contract requires one line for each beat it is given, and it keeps every number of each beat. Its estimate is Bible
  11.1's 2k in and 0.5k out, which is $0.0045. Tested through `runRole` with a recorded answer, a retry, and a failed retry. The
  stage does not call it (see deferred).
- **The manifest writer (`deliver/manifest.ts`, `deliver/calls.ts`, `deliver/cost.ts`).** Manifest v2 for each delivered video. Shots
  are named from the takes its EDL plays. Gates are those of the video (its own, and the request's). Cost is split into the four
  buckets of `budgets.fixedStages`. Each ledger row is attributed to one video, so the manifests of the delivered videos hold every
  paid call once. The role calls and prompt versions go on the master's manifest only.
- **The deliver stage (`jobs/handlers/deliver.ts`).** Chooses the delivered videos. Reconciles each open ledger row as a flagged
  estimate, then releases the reservation to what is committed, under the reservation's lock. Writes one manifest per delivered
  video under a stable id, so a retry writes nothing twice. Emits `cost.reconciled`, `gate.result`, `video.delivered` (with the
  configuration versions), `variant.delivered` and one `request.delivered`. Each event has a dedupe key, so a retry emits nothing
  twice.
- **Events (`events/`).** `schema.ts` has the Bible 16.1 kinds (`plan.decided`, `take.checked`, `shot.downgraded`, `review.decided`,
  `gate.result`, `video.delivered`, `cost.reconciled`) and three the engine adds (`request.delivered`, `variant.delivered`,
  `variant.planned`). Each body is validated, and free text from a check is dropped (`take.checked` keeps rule names and scores).
  `store.ts` is the `EventStore` interface and an in-memory store. `emit.ts` validates and appends.
- **Write-once (`deliver/write-once.ts`).** An artifact under a stable id is reused on a retry when its body is the same, and refused
  when it differs.

## Tests (this worktree)

- `src/engine/variants/`: expand (16), diff (25). `src/engine/deliver/`: ledger (4), cost (7), manifest (16), videos (7), calls (5),
  boundaries (6). `src/engine/events/emit.test.ts` (13). `src/engine/claude/roles/variant_writer.test.ts` (17).
  `src/engine/jobs/handlers/variants.test.ts` (8, PGlite). `src/engine/jobs/handlers/deliver.test.ts` (7, PGlite).
  All E5 files together: **131 pass, 0 fail.**
- The acceptance tests of Bible 6.13 and of the lead's list, as tests:
  - a caption-only variant triggers no generation call: `variants.test.ts`, the first test (no ledger entry, a re-render EDL, no work).
  - twenty variants from one master plan their work without any generation for caption and music, and all twenty are built:
    `variants.test.ts`, the twenty-variant test; and `expand.test.ts`, which plans twenty with no work.
  - a hook variant regenerates only the hook shots: `expand.test.ts` (`produceShotIds` is the hook shot only, `voiceBeatIds` the hook
    beat only).
  - the manifest contains every paid call: `deliver.test.ts`, the first test (the manifests' costs add up to the ledger's committed
    total; each role call is listed on the master).
  - the reservation is released at deliver: `deliver.test.ts` (state `released`, `reservedUsd` 0.5906 = the committed total).
- `npm run typecheck`: exit 0. `npm run lint`: 0 errors, 4 warnings, the same four in `src/components/` as the baseline.

## Owner must run live

Agents hold no keys. These are the steps the owner runs, after the E4 render and review stages exist (they are not on this branch):

1. Caption variant render: after the merge, produce a master, then run the variants stage on a caption matrix. Record the variant EDL
   artifact ids, the `variant.planned` events, the variant render's ledger row (its `idempotencyKey` must equal its composition hash,
   or the variant's cost is not attributed to it), and the variant's manifest with its cost. Expected: no `produce_shot` or `voice`
   ledger row is added by the variants stage.
2. Variant writer, live: `runRole` with `variant_writer` on the hook beat of one recorded request (the check route, `llm.check`). Record
   the answer, the ledger row (`role` = `variant_writer`, `promptVersion` = `variant_writer@1`, the bill), and the role-call row.
   The check route's rate is still $1 / $5 until its owner check (prices@2).
3. Deliver on real PostgreSQL: run the deliver stage against the engine tables. Record the `engine_artifacts` rows of type `manifest`
   (one per delivered video, `organization_id` set), the reservation's state and `reserved_usd`, and the `engine_events` rows, with
   the dedupe keys. Run it twice: the second run must add no row.

## Blockers and decisions for the lead

1. **The orchestrator does not pass the variants stage its inputs.** `orchestrator.ts` gives `variants` only the master EDL
   (`nodeSlots.variants`), and `registry.ts` declares `reads: ["edl"]`. The stage needs `production_request` and `scene_plan` as
   well, and refuses without them (fail closed). Change: add `request` and `plan` to `nodeSlots.variants`, and widen the registry
   `reads` for `variants`. This is eng-pipeline's file.
2. **`deliver` reads every artifact.** The orchestrator passes every slot to `deliver` (`Object.keys(state.artifacts)`). The registry
   declares `reads: []`. The stage relies on the orchestrator's behaviour, so the registry should list what it reads.
3. **Generation variants are deferred.** Hook, product, persona and language variants are planned and reported, not built. Building
   them needs a variant sub-graph in the orchestrator: a `produce_shot` job per listed shot, a voice job per listed beat, the writer,
   then the EDL rebuild for the new inputs, then compose, render and review. None of that exists. The stage reports each one as
   `deferred` with its work, and charges nothing.
4. **The reservation is released at deliver.** A deferred generation variant that is later built needs a funded reservation, and a
   released one funds nothing (`reserve`/`extendReservation` would need a new reservation). Decide before the sub-graph is built.
5. **Contract and client mismatch on invalid answers.** Manifest v2 holds an invalid answer as the estimate (`actualIsEstimate` must
   be true). The client (`claude/client.ts`) holds an invalid answer at its billed cost when the provider reports one, with
   `actualIsEstimate` false. Such a call would make the manifest refuse (`deliver/calls.ts` throws `internal`, so the request pauses,
   which is fail closed). The fix is the lead's call: a contract change (the invalid answer's cost is a bill, so the flag would be
   false), or a client change (hold the invalid answer at the estimate). Not fixed here: it is a contract question.
6. **`configVersion` is not in the manifest.** Bible 16.3 wants the configuration version on the manifest. The contract has no field
   for it, so `video.delivered` carries it (`configVersions`: contracts, thresholds, budgets, prices, routes, adapters, weights). A
   manifest contract bump would add it.
7. **Disclosure flags (Bible 20.2 is open).** `aiGeneratedPeople` is set when a generated shot of the video is a presenter
   (`ugc_presenter`), a `cinematic` shot (treated as possibly showing a person), or an `avatar` or `lipsync` model. `paidPartnership`
   has no source in the request, so it is passed in through a port, and when no answer is given it is `true`. A `paidPartnership`
   answer from the owner is needed. This is a flag only; no wording is written.
8. **Gate and decision events are written at delivery.** The `gate.result` events come from the stored `engine_gate_results` rows, so
   they are written at deliver rather than when each gate is produced. Emitting them from the orchestrator's effect writer would
   make them real-time. The keys make either choice safe to repeat.
9. **`engine_manifests` is not written.** The manifest is an artifact (`manifest` type, immutable). The `engine_manifests` table
   (Bible 5.4) has no row. Decide whether the table is a second write.
10. **No Postgres event store.** `EventStore` is an interface with an in-memory store. The row shape matches `engine_events`
    (`on conflict (organization_id, dedupe_key) do nothing`), so the lead or eng-pipeline adds it.
11. **Calls that never returned.** A pending call has a ledger hold, which is counted in `request.delivered` (`unansweredCalls`),
    but it is not in `roleCalls`: the contract has no verdict for a call with no answer.
12. **Timings.** `timings` holds, for each artifact type, the milliseconds from the request to that type's first artifact, and
    `total` (to the video's passing review). These are elapsed times and include queueing, not stage durations. The job timings from
    Meridian's queue would be better.
13. **Music mix.** `variants/config.ts` mirrors `edit/tuning.ts` (`-12` dB gain and `-18` dB duck). A test checks the mirror. The
    music variant copies the master's mix when the master has music.
14. **Variant render attribution.** A render's ledger row is linked to its video by its idempotency key, which is the composition hash
    (`compositionFixture.contentHash`, Bible 6.11). A render whose key matches no delivered video counts toward the master, so every
    paid call is counted once.

## Not built in E5

Generation for hook, product, persona and language variants (the sub-graph above), the writer's call inside a variant sub-graph, the
Postgres event store, the call that wires these handlers into the worker (`registerEngineHandlers`), and the gold-set and review
events (`review.decided`, `take.checked`, `plan.decided`, `shot.downgraded`), whose schemas exist and whose emitters belong to the
stages that decide them.
