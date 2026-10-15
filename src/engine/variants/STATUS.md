# STATUS: variants (W13, phase E5)

## E5 item 3: the generation variant sub-graph (this branch)

Scope of this branch (lead task, six items). Every piece is built and tested with recorded answers. No live call was made.

Done:
1. **Work list (`variants/work.ts`, `jobs/types.ts`, `jobs/orchestrator.ts`, `jobs/variant-runs.ts`).** The variants stage's request phase
   hands over `work`: one item per funded generation variant, with its attribute, its writer call (`lines` for a hook or language,
   `product_prompts` for a product, none for a persona), the beats the voice speaks again, and the generated shots it makes again. The
   orchestrator keeps one run per variant. It queues the variant's phases as jobs (writer, then voice, then plan), then one produce job for
   each shot the change makes again, then one check job for each take. Each run has its own subject (`variantSubjectOf`, a slug of the key
   with a digest, no `:` or `.`), its own shot and take maps, and its own artifacts (`plan:<key>`, `voice:<key>`, `take:<id>`,
   `verdict:<id>`). None of them is a request artifact, so deliver still reads one scene plan. The phase outputs are typed in
   `StageOutput` (`phase: request | writer | voice | plan`). A stage job's `details.phase` picks the phase.
2. **Production wiring (`jobs/production-ports.ts`, `jobs/runtime.ts`).** `productionEngineRuntime` passes `variants` from
   `productionVariantPorts`: the writer's route through the gateway (`llm.check`, its key from Meridian's resolver, a route with no key is
   NOT_CONNECTED before any call), the kits from the workspace's `engine_kits` rows (product kits by SKU, `productKitBySku`), the monthly
   budget from Meridian's Settings, the event table. The voice is NOT connected in production: no voice port is built (no router, no audio
   loader, no media functions), so a variant that needs a voice is reported NOT_CONNECTED with its reason. Nothing is called. Music is not
   connected either.
3. **Voice: full re-speak (deliberate deviation, recorded).** Bible 6.13 asks for the changed lines only. An EDL holds one voice clip
   (`contracts/edl.ts`, `audio.voice`) and there is no splice. So a variant that changes any line speaks its whole script: every beat of
   the master, with the writer's lines in place of the beats it changed (`variantRequestFor`, `speakVariantScript`). A persona speaks the
   master's own text in its voice. A product speaks nothing. Cost: the speech of the unchanged beats (small, and it is on the ledger). The
   ledger row is the voice stage's own call (`stage` `voice`, `requestId` the request), and its idempotency key is the router's cache key
   of the spec, which is scoped to the variant (below). Deliver attributes a voice row to the master unless it is linked to the variant;
   the link is a follow-up (below). Changed-lines-only needs the EDL audio contract change (`audio.voice` as an ordered list, plus a
   `spliceAudio` media function). That waits for the owner's approval.
4. **Product swap prompt (`prompts/variant_writer@2.md`).** The prompt of a product variant named the master's product, because the shot's
   prompt is the planner's text. Now a product variant's writer call (task `product_prompts`) writes a new prompt for each product shot it
   changes, naming the variant's product (its kit's name). `variantScenePlan` applies the prompts to those shots only. Every other shot is the
   master's object. The writer's check (`variant_writer_answer`) refuses a prompt that names no product, one that keeps the master's product,
   one with quotation marks, or one missing a shot. `variant_writer@1.md` is kept as shipped and pinned (its lines task is unchanged in @2).
   **Owner or lead to confirm:** the planner's prompt checklist says "No names" (`prompts/planner@1.md`). The variant prompt names the product
   by its kit name, as the lead asked. The name is an identifier, not text to draw, and the prompt is told to ask for no lettering. A video
   model may still draw the name. Confirm the policy before a live run.
5. **Hook variants (design, written here as the lead asked).** A hook change changes the hook line's voice and the hook shot's presenter
   take. So the hook shot is produced again when it is generated (a presenter, or a cinematic shot). A coded hook (kinetic type, a component)
   produces nothing: its plan has no shot to make again, and the variant is produced at once, with its voice and its plan. Tested in
   `handlers/variants-generation.test.ts` and `variant-orchestration.test.ts`.
6. **Tests.** See "Tests" below. The six required tests are in place. Each names the behaviour it checks.

What a variant does not do yet (the sub-graph is not finished as a video):
- **No assembly.** A generation variant ends `produced` (every changed shot has a take that passed its check) or `failed` (with its reason).
  A produced variant's takes are kept, but no EDL is built from them: the assembly (EDL with the new takes and voice, then compose, pre-render,
  render and review) is not built, and it needs the audio splice contract (item above). Its takes are paid for and not yet used. This is the
  main cost risk of this branch: owner or lead must decide whether produce runs before the assembly exists (the decision on the manifest is
  "produced: not assembled"). Until the assembly exists, generation variants are not delivered.
- **Variants fail alone.** A dead job, a refused or held produce, a plan that names other shots, a writer or voice that is not built, and a
  take that fails its checks after the shot's redos each end that variant with its reason. A redo of a variant's shot uses the shot's redos
  (`orchestratorLimits.shotRedos`) and the failed rule names as hints. An escalated take fails the variant: a variant has no human choice. No
  review item is opened for a variant.
- **Gate results of variant takes** are not written as gate effects (they would count against the master's manifest). The verdict artifact
  is kept under `verdict:<takeId>`.

Other changes in this branch:
- `variants/speak.ts`: `speakVariantScript` replaces `speakChangedLines`. The voice runner takes absent ports (`VoiceRunner`) and refuses
  before any call when none are wired (`runVoiceOverPorts`).
- Call scope (`variants/work.ts` `callScopeOf`, `variants/speak.ts` `scopedVoicePorts`). The asset router keys its cache and its ledger on the
  spec's content and seed, and not on the voice (`assets/router.ts`, `assetCacheKey`). The same text in another voice would therefore return,
  or be charged as, the master's narration. A variant's speech spec carries its scope in its seed, so no two variants share a cache entry or a
  ledger key. **The root fix belongs to the router (W5): key the cache and the ledger on the voice id too.** Not changed here: `assets/` is
  not this workspace's file.
- `jobs/handlers/produce-shot.ts`: a produce job names its shot in its details (`shotId`), and its take id and asset spec are named by its
  subject. For a master job the subject is the shot id, so the master's ids and seeds are unchanged. A variant's take is never the master's.
- `jobs/handlers/variants.ts`: rewritten in phases. The request phase reads the request, the plan and the master EDL. The writer, voice and
  plan phases read the request and the master plan. Each phase checks its connection before any paid call, and a missing model is
  NOT_CONNECTED with its reason (the request phase defers the variant and queues no work, and funds nothing).
- `jobs/registry.ts`: `variants` is a generation-class stage (10 minutes), since its voice phase is a generation call. It writes EDLs, scene
  plans and voice tracks.

## Tests (node:test, recorded answers, PGlite, no live call)

- The six required: (1) a hook queues one writer call, one voice and one produce for the hook shot only (`variant-orchestration.test.ts`
  "a hook variant queues one writer call..." and "a hook variant produces its hook shot only..."; `handlers/variants-generation.test.ts`
  "a hook variant calls the writer once..."). (2) A product re-produces only the shots it changes (`variant-orchestration.test.ts`,
  "a product variant writes its prompts..."; `variants-generation.test.ts`, "a product variant rewrites the prompts..."). (3) A caption variant
  queues no generation (`variants-generation.test.ts`, "a caption variant queues no generation..."; `variants.test.ts`). (4) The reservation
  is raised at the request phase and released at deliver (`variants-generation.test.ts`, "the reservation is raised..."; `deliver.test.ts`).
  (5) A variant over the request budget is refused with its reason (`variants-generation.test.ts`, "a variant over the request budget...").
  (6) Without a connected model, a generation variant is NOT_CONNECTED with its reason and no call (`variants-generation.test.ts`, "without a
  connected model..."; `variants-production.test.ts`, the connection of the production ports).
- Also: the writer role on two tasks and its answers (`claude/roles/variant_writer.test.ts`, 23); the writer's calls (`variants/writer.test.ts`,
  10); the voice's full script, its refusals and the call scope (`variants/speak.test.ts`, 9); the work list and its phases (`variants/work.test.ts`,
  13); the product prompts in the plan (`variants/plan.test.ts`, 12, two of them new); the orchestrator's variant runs
  (`jobs/variant-orchestration.test.ts`, 11); the request and phase handlers with the six tests and the produce subject
  (`jobs/handlers/variants-generation.test.ts`, 15); the production ports and the SKU lookup against PGlite (`jobs/variants-production.test.ts`, 4);
  the prompt pins (`prompts/load.test.ts`, 5, with both writer versions).
- Run on this branch: `NODE_ENV=development node --experimental-strip-types --test 'src/engine/jobs/*.test.ts' 'src/engine/jobs/handlers/*.test.ts'
  'src/engine/claude/**/*.test.ts' 'src/engine/prompts/*.test.ts' 'src/engine/variants/*.test.ts' 'src/engine/events/*.test.ts'
  'src/engine/deliver/*.test.ts'`: 673 pass, 0 fail, 0 skipped. `npx tsc --noEmit`: exit 0. `npx eslint` on the changed files: 0 errors,
  0 warnings.

## Owner must run live (agents hold no keys)

1. **Variant writer, product task, live.** After the merge, run `runRole` with `variant_writer` on the product prompts of one recorded
   request (the check route, `llm.check`). Record the answer, the ledger row (`role` = `variant_writer`, `promptVersion` = `variant_writer@2`,
   the actual cost) and the role-call row. The check route's rate is still $1 / $5 until its owner check (prices@2).
2. **Voice for a variant: not possible yet.** The variant voice needs the speech route, speech-to-text, the media functions and the audio
   loader wired in production (none is). Do not run it until they are: record the voice's ledger row, its `idempotencyKey` (scoped to the
   variant), and its track's duration.
3. **Produce of a variant's shot, live, only after the owner decides the produce-before-assembly question (above).**

## Blockers and decisions for the lead

1. **Assembly of a generation variant** (EDL with the new takes and voice, then compose, pre-render, render, review): not built. Needs the EDL
   audio contract (`audio.voice` as an ordered list) and a `spliceAudio` media function, which the lead must approve (contracts owner, Bible
   section 4 note). Until then a produced variant is not delivered.
2. **Produce before assembly.** The variant's takes are paid for and not used until the assembly exists. Decide whether the produce phase
   waits for the assembly, or runs now and is accepted as a cost (the manifest says "produced: not assembled").
3. **Router cache and ledger key ignore the voice** (`assets/router.ts`, W5). Scoped in the variant path (seed), so this branch does not
   share a cache entry across voices. The router should key on the voice id as well.
4. **Voice attribution in deliver.** A variant's voice row is attributed to the master by default. Linking it to its variant (the voice's
   idempotency key carries the variant's scope) is a follow-up in `deliver/`.
5. **Planner prompt rule "No names" versus the product variant's prompt** (above). Owner or lead to confirm.
6. **Production voice is not wired** (above). Every variant that needs a voice is NOT_CONNECTED in production until it is.
7. **Month budget in production** reads Meridian's Settings through `workspaceBudgetFromSettings`. Unset, a raise of the reservation is refused
   with the reason (as before).
8. **Deliver reads one scene plan.** The variant's plan and voice are not request artifacts, so deliver is not affected. A variant's shot
   takes are not request takes either.
9. **Timings and leases.** The variants stage is generation class (10 minutes). Each phase is a job of its own, so a voice's long call has its
   own lease. The whole stage is not one job any more.

## Earlier work (still in this branch)

- **Expansion (`expand.ts`, pure).** The six attributes of Bible 6.13. Each planned variant has one control (the master EDL and the
  attribute, with `from` and `to`), its work, its build and its estimate (`config/budgets.ts`, the high end). The fit is cheapest first, then
  the matrix order, and it names the limit that stops each variant. Its `work` is the expansion's (a hook: the hook beat only). The work list
  of a generation variant (`variants/work.ts`) is the full re-speak.
- **Funding (`reserve.ts`, `extendForVariants`).** The variants that run are funded under the request's reservation before any call. The hold is
  set to the committed spend plus the funded estimates (never lowered, idempotent). A raise above the request budget, above the workspace month,
  or with the month budget not connected is refused with the reason, and nothing is written. `deliver` releases the rest.
- **EDL diffs (`diff.ts`, pure).** `diffEdl` names each changed surface. `checkControl` refuses a variant that changes more than its attribute
  allows. Caption and music variants are built from the master and checked (`buildRerenderVariant`).
- **Variant plan (`plan.ts`).** `variantScenePlan` changes the references and, for a product, the prompts of the touched generated shots only.
  Every other shot is the master's. The plan is validated against the scene plan contract.
- **The manifest writer (`deliver/manifest.ts`, `deliver/calls.ts`, `deliver/cost.ts`).** Manifest v2 for each delivered video. Each ledger row is
  attributed to one video, so the manifests of the delivered videos hold every paid call once. The role calls and prompt versions go on the
  master's manifest only.
- **The deliver stage (`jobs/handlers/deliver.ts`).** Reconciles each open ledger row as a flagged estimate, releases the reservation to what is
  committed, writes one manifest per delivered video under a stable id, and emits `cost.reconciled`, `gate.result`, `video.delivered`,
  `variant.delivered` and `request.delivered`, each with a dedupe key.
- **Events (`events/`).** The Bible 16.1 kinds and the three the engine adds (`request.delivered`, `variant.delivered`, `variant.planned`).
  A generation variant's `variant.planned` is written once, at its plan (deferred, its takes queued; or deferred with no take), or at its
  first failing phase (not_built, with the reason). Its `work` is mapped onto the existing body (produce, voice, writer beat ids).
- **Write-once (`deliver/write-once.ts`).** An artifact under a stable id is reused on a retry when its body is the same, and refused when it
  differs.
- **Caption fixture (`jobs/test/caption-variant.ts`).** The chain master with its captions split, so the caption after the presenter moves.

## Not built in E5 (still open)

The assembly of a generation variant (above); the audio splice; the Postgres-side variant run store (the run is in the orchestrator's state
JSON, so it is durable with the request); the voice of a variant in production; the link of a variant's voice row to the variant in deliver.
