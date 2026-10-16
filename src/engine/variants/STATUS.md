# STATUS: variants (W13, phase E5)

## E5 item 3: the generation variant sub-graph, assembled and rendered (this branch)

What a generation variant (hook, product, persona, language) does now, end to end, on recorded answers:

1. **Work list.** The variants stage's request phase funds the variants that can run and hands the orchestrator one work item for each
   (`work.ts`, `VariantWorkItem`): its writer call, the beats it speaks again, and the generated shots it makes again.
2. **Phases (one job each).** writer (`variants/writer.ts`, the variant writer role: lines, or a product's shot prompts), voice
   (`speak.ts`, the variant's full script through the voice stage), plan (`plan.ts`, the master's plan with the change).
3. **Produce and check.** One produce job for each shot the change makes again, one check for each take; a failing take is redone with the
   shot's redos, then the variant fails.
4. **Assembly (new).** `assemble.ts`: the EDL is built by the editor (`edit/editor.ts`, `buildEdl`) over the variant's own inputs: its plan,
   its voice, the takes its EDL plays (its own take for each shot it changed, the master's accepted take for the rest), the same style kit and
   the same DNA. It carries `variantOf` the master EDL. It passes the same edit rules as the master, or the variant fails with the failing checks.
5. **Chain (new).** The variant's EDL is a branch of its own (`BranchState.variantKey`). Compose, pre-render, render and review run for it as
   for the master. Its pre-render gate reads the variant's plan and voice, and the takes its EDL plays (not the master's plan).
6. **Delivery (new).** A run is `produced` when its chain passes review. Deliver waits for every run to end. It receives the variant's EDL
   (a request artifact: `edl:<id>`), and the variant's takes (`take:<id>`), so the EDL's media resolves. Deliver chooses the variant as it
   chooses the master (`deliver/videos.ts`: a variant of the master whose render passed review).

Failure, for every generation variant: any failure ends that variant alone, with a decision in the manifest that says why (a phase, a
produce job with no take, a failing take after its redos, an assembly that does not pass the edit gate, a chain that does not pass review,
a dead job of any of them). The request is never paused by a variant and the master's shots and edit are never revised by a variant.

### The assembly is a rebuild, not a copy (a deviation from the copy design)

The brief for this step was "the master EDL with audio.voice set to the variant's track and the changed shots' take URIs swapped in". I did
not build it that way, for one reason: the EDL's captions and cut timing come from the voice's words (`edit/editor.ts`, step 9, and the
caption rules). A copy with a new voice would keep the master's caption text and the master's word timings, so a hook variant would show the
old opening on screen while its narration says the new one. The editor rebuilds the EDL from the variant's own inputs instead, so the captions,
the cuts and the voice clip all come from the variant's words, and the edit rules check them. For a product variant (the same narration) the
rebuild gives the same EDL as the copy, with the new take. The copy would be correct only for a variant that keeps every word, which none of
the six attributes does except a product or a caption change.

### Voice: full re-speak, and the splice as a recorded future step

- The voice is re-spoken whole (Bible 6.13 asks for the changed lines only; this is the recorded deviation). The assembly uses the variant's
  track as the EDL's `audio.voice` (its clip starts where the master's did, and it ends where the track ends).
- **Future step (not built, not needed for this design):** changed-lines-only needs the EDL audio contract to hold an ordered list of voice
  clips (`contracts/edl.ts`, `audio.voice`), a `spliceAudio` media function in a serverless function, and the owner's approval for the contract
  change (Bible section 4 note). Record it as the next step when the cost of the full re-speak matters.

### Router: the voice is part of the speech cache key (fixed here)

The asset router keyed its cache and its ledger on the spec alone, so two voices speaking the same text shared a cached take. Fixed at the
router (`assets/cache.ts`, `routeCacheKey`), with two tests. See `assets/STATUS.md`. The variant path's seed-shifting workaround is removed.

### Still deferred, and why

- **Production has no voice and no produce.** `productionVariantPorts` builds no voice port (no router for speech, no audio loader, no media
  functions), so a variant that needs a voice is NOT_CONNECTED before any call. The production runtime also registers no `produce_shot`
  (no shot ports), so a generation variant's produce job is not run in production either: its run ends failed, with the reason. Both wait on
  the worker's composition (`jobs/STATUS.md`).
- **Attempts in the manifest.** Deliver counts the takes of a shot across the request, so a variant's manifest shows the master's takes in
  the attempt count of a shot it changed. The count is real (every take exists), but it is not the variant's own redos. Fixing it needs the
  takes' lineage in deliver (a follow-up in `deliver/`).
- **`variant.delivered` attribute.** For a generation variant the attribute is null: the EDL alone cannot name it (deliver's diff finds caption
  and music changes only). The `variant.planned` event carries the attribute.
- **Gate results of variant takes** are not written as gate effects (they would count against the master's manifest); the verdict artifacts
  are kept (`verdict:<takeId>`). The assembly's edit gate and the chain's gates are written, with the variant's EDL id as their subject.
- **Learning events after the plan.** The variant's `variant.planned` is written at its plan (deferred), at its assembly (built, or not_built),
  and at a failing writer or voice (not_built). A failure in produce or in the chain is recorded as a manifest decision, not as an event.

## Tests (node:test, recorded answers, PGlite, no live call)

- `variants/assemble.test.ts` (3): the variant EDL is a variant of the master, passes the edit rules, speaks the variant's narration and plays
  the variant's take; its captions carry the variant's opening word and not the master's; a missing take is not built, with the failing rules.
- `jobs/handlers/variants-generation.test.ts` (18, with the earlier six behaviours): the assembly phase writes the variant's EDL when its gate
  passes (output validated against the stage's output contract), writes nothing when the gate fails, and is not built when the style kit does
  not load.
- `jobs/variant-orchestration.test.ts` (20): the assembly reads the variant's own inputs (its plan, DNA, voice and takes, not the master's voice
  or the master take it changed); a passing assembly becomes a branch whose compose runs on the variant's EDL, and the master's edit is not
  run again; the pre-render reads the variant's plan, voice and takes; a passing review produces the variant and queues delivery with its EDL;
  an unproven pre-render failure is reviewed in the variant's own branch (no pause, no master edit); a dead compose fails the variant alone; an
  assembly that does not pass fails the variant with the rule names; a variant with no changed shot is assembled after its plan; a dead
  assembly fails the variant alone.
- `variants/work.test.ts`, `variants/speak.test.ts`, `variants/writer.test.ts`, `variants/plan.test.ts`, `claude/roles/variant_writer.test.ts`,
  `prompts/load.test.ts`: unchanged in substance (the seed-scope tests are removed with the workaround).
- `assets/router.test.ts` (21, +2 speech): two voices on the same text are two calls and two ledger rows; the first voice again is a hit.
- Run on this branch: the job, handler, claude, prompts, variants, events, deliver and assets suites: 809 pass, 0 fail. The voice, ops, edit,
  review, budget, analyze and plan suites: 812 pass, 1 fail. The one failure is `plan/chains.test.ts`, "without a price stop_motion is removed by
  rule 5": it fails when run alone too, and none of its imports is a file this branch changed (plan, config and compose are untouched), so it
  is a failure of the merged base. `npx tsc --noEmit`: exit 0. `npx eslint` on the changed files: 0 errors, 0 warnings.

## Owner must run live (agents hold no keys)

1. **Variant writer, product task, live.** Run `runRole` with `variant_writer` on the product prompts of one recorded request, through the check
   route. Record the answer, the ledger row (`promptVersion` `variant_writer@2`) and the role-call row. The check route's rate is still $1 / $5
   (prices@2, an owner check).
2. **Assembly and chain, live, once the worker's voice and produce are wired.** For one hook variant: the variant's voice (speech route,
   speech-to-text, media functions), its produce, its assembly, then compose, pre-render, render and review. Record the variant EDL id and its
   `edl:` artifact, the `variant.planned` events, the render's ledger row (its idempotency key is the composition hash), the post-render review,
   and the variant's manifest with its cost.
3. **The product prompt's naming (owner decision, not changed here).** The planner's prompt checklist says "No names" (`prompts/planner@1.md`).
   The product variant's prompt names the product by its kit's name, as the lead asked. The name is an identifier, not text to draw; the prompt
   asks for no lettering. A video model may still draw the name. Confirm the policy before a live run.

## Blockers and decisions for the lead

1. **Production wiring for a generation variant.** The voice port and the produce ports are not composed in production (above). Until they are,
   no generation variant is assembled in production; each ends NOT_CONNECTED or failed with its reason.
2. **Produce before assembly is no longer open:** the takes are used by the assembly (a produced variant is assembled and rendered). The
   cost of a variant that fails its review after its takes is paid and recorded.
3. **Deliver's attempt count and the variant attribute** (above): a follow-up in `deliver/`.
4. **Planner rule "No names" versus the product variant's prompt** (above). Owner decision.

## Earlier work (still in this branch)

- **Expansion (`expand.ts`, pure).** The six attributes of Bible 6.13. Each planned variant has one control (the master EDL and the
  attribute, with `from` and `to`), its work, its build and its estimate (`config/budgets.ts`, the high end). The fit is cheapest first.
- **Funding (`reserve.ts`, `extendForVariants`).** The variants that run are funded under the request's reservation before any call; a raise
  above the request budget, above the workspace month, or with the month budget not connected is refused with the reason. `deliver` releases
  the rest.
- **EDL diffs (`diff.ts`, pure).** Caption and music variants are built from the master and checked against their control. They are chained
  as the generation variants are (compose, pre-render, render, review).
- **Variant plan (`plan.ts`).** `variantScenePlan` changes the references and, for a product, the prompts of the touched generated shots only.
- **The manifest writer (`deliver/manifest.ts`, `deliver/calls.ts`, `deliver/cost.ts`).** Manifest v2 for each delivered video. Each ledger row
  is attributed to one video; the role calls and prompt versions go on the master's manifest only.
- **The deliver stage (`jobs/handlers/deliver.ts`).** Reconciles each open ledger row, releases the reservation to what is committed, writes one
  manifest per delivered video under a stable id, and emits its events, each with a dedupe key.
- **Events (`events/`).** The Bible 16.1 kinds and `variant.planned`, `variant.delivered`, `request.delivered`.
- **Write-once (`deliver/write-once.ts`).** An artifact under a stable id is reused on a retry when its body is the same, and refused when it
  differs.
- **Caption fixture (`jobs/test/caption-variant.ts`).** The chain master with its captions split, so the caption after the presenter moves.
