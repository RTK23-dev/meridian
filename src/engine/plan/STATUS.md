# STATUS: the plan stage (W7), E3 and E5 (W9 plan-side support)

## Cartoon chain end to end (contract v5): cartoon_generated built and tested; stop_motion refused until image.edit is priced

Branch `worktree-agent-adcc78d81ea833bab`, on top of `244e3e8`. The plan side hands the chain to the stages (`jobs/handlers/plan.ts`,
`jobs/orchestrator.ts`, `jobs/handlers/produce-shot.ts`, `edit/editor.ts`; see their STATUS files).

**What changed in plan/**

- `sources.ts` `cartoonGeneratedChain`: the keyframe carries every character reference. The clip sends NO references (`refs: []`) and
  starts from the keyframe. Reason: the video adapter has no reference field and its profile's `refsMax` is 0, so a reference on the clip
  is refused before any call. The contract fixture (`contracts/fixtures/chain.ts`) still lists the sheet on the clip. The contract owner
  decides whether to align it; it is not changed here.
- `sources.test.ts`: the cartoon chain pin is the new form.
- `chains.test.ts`: "both sides at the filter" asserts the current rule. Without a price, rule 5 removes stop_motion (`unknown_price`).
  With a price, the filter keeps it, because `stopmotion.player` is in the component library (merged from d1f532e), so no rule removes it.
  stop_motion stays refused while image.edit has no price.

**Still refused, and why**

- stop_motion, while image.edit has no price (rule 5, `unknown_price`). It is also refused by the plan stage's summary (`shotSummaryOf`)
  while its last call is an image: the orchestrator does not place its closing component yet.

**Tests (this section)**

- `chains.test.ts` 13 pass. `sources.test.ts` passes. The plan, edit and assets test folders run 453 tests, 0 fail.
- The cartoon chain end to end is `jobs/cartoon-chain.test.ts` (3 tests, recorded transport, PGlite).

**Owner's live run (agents hold no keys)**

1. Price image.edit (per image, per call) in `config/prices.ts` and set its OpenRouter model id in `config/routes.ts`. Plan a stop-motion
   beat: rule 5 passes, and the plan still refuses the shot until the closing component is placed.
2. Plan a cartoon beat on a page with a generated character sheet whose references are fetchable https links (see
   `jobs/handlers/STATUS.md`). Record the cartoon shot (the keyframe with its references, then the clip with none), the plan gate's checks,
   and the estimate's two lines.

## Chains (contract v5): cartoon_generated and stop_motion are planned as chains (branch `worktree-agent-a2631ad1048c21356`, from `cef526c`)

This section supersedes the chain items of the E5 and E3 sections below: the build gaps for cartoon_generated, the single-call
recipe for stop_motion, and "stop-motion and cartoon chains still refused by buildSource".

**What is built**

- **`chains.ts` (new, pure).** The calls of each chain type (`chainStepsOf`): cartoon_generated is `keyframe` (image.keyframe), then
  `clip` (video.budget, first frame the keyframe); stop_motion is 24 to 36 frame calls `frame_01` to `frame_NN` (image.edit), from
  `stopMotionTiming` (moved here from sources.ts). The same steps price the chain (`chainPriceOf`, `callPriceOf`), with the estimate's
  billing rule (budget/estimate.ts): per second times the shot's length and the takes, or per image or per call times the takes. Each
  call is rounded to 4 decimals, as the estimate rounds each line, and an unknown call makes the whole chain unknown. `closingComponentOf`
  names the closing component (stop_motion: `stopmotion.player`, a component, not a call); `closingComponentProblem` checks it against the
  library the caller gives (`libraryHas` is the default).
- **`tables.ts`.** `RECIPES` has `{ kind: "chain" }` for both types (the frame-billing recipe is gone). `isGeneratedType` is true for a
  chain. `BUILD_GAPS` no longer lists cartoon_generated. `GENERATION_CHAINS` and `CHAIN_TYPES` moved to chains.ts. `BUILDABLE_TYPES` is
  "no static gap". `ARTIFACT_RISK_PRIOR.chain` is the generate prior (a chain is generated).
- **`cost.ts`.** `shotCost` prices a chain as the sum of its calls, with the redo allowance on the sum. `KnownShotCost.calls` is new (the
  paid generation calls: 1 for a generate type, the chain's length, 0 for stock and components). Every unknown reason starts with
  `unknown_price:`.
- **`filter.ts`.** Rule 5 passes the cost's reason through (`unknown_price: <the image.edit route> has no known price (the chain makes 30 calls)`).
  Rule 6 checks the closing component after the kit check, so the price comes before the library (rule 5 before rule 6, as in 7.2).
- **`minimum.ts`.** A chain ranks as generate. An unknown price stays an option, so the minimum refuses with `unknown_price` (it did
  before). A priced type whose closing component is missing is not an option.
- **`sources.ts`.** `buildSource` returns the chain as the shot's source (`{ kind: "chain", calls }`, layer base). `cartoonGeneratedChain`
  returns the two calls, with every character reference on both and the keyframe as the clip's first frame, both in the code's look.
  `stopMotionChain` returns the frames: frame 1 reads the hero image; frame n reads the hero and frame n-1 (as an output name). The
  closing player is not in the chain (the v5 note). `chainKitRefusal` checks the kits without a prompt (a generated sheet with references;
  the hero image; a length the frames can make). `componentBuildRefusals` includes these, so the filter removes the type before the
  planner writes anything.
- **`test/priceOverlay.ts` (new, test only).** `withPriceOverlay` puts a price into the table for one run and restores it in `finally`.
  The budget estimate reads the same table (through `priceFor`), and budget/ is not ours to change, so a test that needs "the owner has
  priced image.edit" has to overlay the table. Production code does not touch it.

**Priced today (list prices, prices@2)**

- cartoon_generated at 3 s: keyframe (the image.keyframe route, one image) $0.018, clip (the video.budget route, per second) $0.0336 a second x 3 = $0.1008. Base
  $0.1188, redo allowance $0.0297, total $0.1485. The estimate's shot lines are the two calls, and their sum is the planner's base.
- stop_motion: `image.edit` is routed to a route whose price is `per_token` with no usd, so every frame is unknown.

**Refused, and why**

- **stop_motion, until the owner prices image.edit (rule 5, reason `unknown_price`).** The reason names the first unknown call and
  the number of calls. Tested both ways: without the price, rule 5 removes it; with a per-image price in the overlay, rule 5 passes.
- **stop_motion, after a price, until stopmotion.player is in the component library (rule 6).** The reason is "no source can be built for
  it yet: the closing component stopmotion.player is not in the component library yet". This is deliberate: a plan that chose stop_motion
  could not be drawn. The produce stage refuses the same chain before its first call (chains produce `config`, no call made).
- **Any stop-motion shot that is not 2 to 4.5 seconds (rule 6, the build refusal).** The frame bounds in 7.1.
- **cartoon_generated with no generated character sheet, or a sheet with no references (rule 6, the build refusal).** A rig sheet is
  not the sheet the chain needs.
- **react_clip** is unchanged (a build gap: no clip source).

**Decisions for the lead (not made in code)**

1. **Merge order (must).** The plan stage refuses any chain shot before anything is stored (`jobs/handlers/plan.ts` `shotSummaryOf`,
   `notImplementedError`). The planner can now choose cartoon_generated, so a plan that picks it fails the plan stage. Before this change
   such a plan could not be chosen (it was a build gap). Land the plan handler and the orchestrator change (point 2) in the same merge, or
   keep the chains out of the planner until they land. The v5 note says the readers come first.
2. **Orchestrator and plan handler (not granted to this task).** `jobs/types.ts` `ShotSourceKind` has no `chain`; `needsProduce` and
   `providerKeyFor` (orchestrator.ts) do not know one; `applyProduce` refuses a takeless output with no hold (a stop-motion chain ends with
   no take, the player draws the frames). A chain needs: `ShotSourceKind` plus `chain`; `needsProduce(chain)` true; `providerKeyFor` by the
   first call's model class; `applyProduce` accepting a closing-component end (no take, no hold) for a stop_motion shot.
3. **The editor (must, before any chain reaches edit).** `edit/editor.ts` treats only `generate` and `stock` as media shots (lines 136
   and 162). So a chain take is refused (`takes_match_plan`), and a chain shot with no take is not required to have one (the editor would
   build an EDL that drops the shot without failing). The fix is one predicate that includes `chain` in both places.
4. **Closing component gate.** Stop-motion stays out of the plan until `stopmotion.player` exists in the component library. Confirm that
   this is the order you want (a price alone does not make the type work).
5. **Stop-motion frames are not kept.** The frames are media in the store, and their uris live in the job's carry until the job ends.
   Nothing persists them as artifacts (no artifact type for chain outputs), so a player stage cannot read them later. A later version
   needs a chain-output artifact (a contract change).
6. **Downgrade and redo.** A refused frame stops the chain, and the planner's one rewrite then re-plans the whole shot, so the frames
   already paid are lost. The redo allowance (25%) does not cover that. A redo of a check failure repeats every call (a new attempt is a
   new seed and new keys), so the redo costs the whole chain again. Both are cost questions for the owner.

**Tests (this section)**

- `chains.test.ts` (new, 13 tests): the chain types; cartoon's two calls and their output names, checked against the contract fixture;
  stop-motion's 30 frames and the 2 to 4.5 second bound; the per-call price; the cartoon chain's sum (0.1188) and its allowance; the
  estimate's lines against the planner (per call, the sum); stop_motion unknown with its reason, and the estimate refuses it; the price
  overlay (30 frames at $0.02, 30 budget lines, the estimate equals the sum, the overlay restored, and restored after a throw); the
  builder's chain costs what its calls cost; the closing component check; both sides at the filter (no price: rule 5; with the price:
  rule 6 for the missing player); every chain type is priced or unknown with `unknown_price`.
- `sources.test.ts`: buildSource returns a chain for both; the cartoon chain's calls; the bounds; the frame chain's inputs (frame 2 reads
  frame 1); the refusals without a sheet, a hero, a prompt or the length; `chainKitRefusal`; `componentBuildRefusals` for chains.
- `tables.test.ts`, `filter.test.ts`, `cost.test.ts`, `minimum.test.ts`: the pins moved to the new behaviour (no cartoon gap, chain recipes,
  `unknown_price` wording, the generated-sheet kit, the price before the closing component).

Run: `NODE_ENV=development node --experimental-strip-types --test src/engine/plan/*.test.ts src/engine/plan/test/*.test.ts`
Result: 219 tests, 219 pass, 0 fail (before this change: 203).

**The owner's live run (agents hold no keys)**

1. Set the image.edit route's price to a per-image price (the chain bills one image per call) in `config/prices.ts`, and confirm its OpenRouter model id in
   `config/routes.ts`. Plan a request with a stop-motion beat: the planner stays without stop_motion until stopmotion.player is drawn; the
   plan's rule 5 check then shows the price.
2. Plan a cartoon beat with a generated character sheet: the plan's cartoon_generated shot has two calls and `estimatedUsd` equals the
   estimate's shot total. Record the estimate's two budget lines and the ledger's two entries after the produce stage (points 1 and 2 above
   must be merged first).

## E5 follow-up: the plan gaps closed (branch `eng-plan-gaps-2`, from `code/beautiful-cori-1zfk11`)

This section supersedes the E5 items it names: decisions 1, 2 and 5 of the E5 section below, and the build-gap list of E3.

**What changed**

- **Word spans (`align.ts` `timedWordsOfShot`).** A shot's words carry their times from the shot's start, clamped to the shot's
  last millisecond. `build.ts` passes them as `SourceShot.spans` to every source (kinetic.type, character.rig, screen.mock).
  Words that start inside the shot use their voice times. A shot that speaks none (the beat's words all lie outside it) gets
  those words spread evenly across the shot in script order. Clamping them to zero would give every line the same start, and
  kinetic.type refuses equal starts. `wordsOfShot` returns the same words as before.
- **The rig sheet (`character.ts`, new).** `rigSheetProblem` and `rigSheetOf`. A rigged sheet drives character.rig only when it
  lists the rig's own names: the `idle` pose, and the `closed` and `open` mouth shapes. `build.ts` passes the first such sheet
  (in the order `kits.characters` gives) to every source. `planKitsOf` counts the rig only when such a sheet exists.
- **Build-time refusals (`sources.ts` `componentBuildRefusals`).** Before the planner writes anything, each component type
  (kinetic_type, coded_graphics, cartoon_rigged, screen_mock) is built from the shot's own words, timings, kits and sheet. A
  refusal is a rule-6 removal for that shot (`refusals`, filter.ts). So the planner never chooses a type the plan cannot draw,
  and the plan does not fail later at `sources_built`. Before this, a one-line screen with no product kit, or a sheet without
  the rig's names, failed the whole plan.
- **Mouth timing (`sources.ts` `mouthTimelineOf`).** A mouth closes no later than the next word opens, so the events stay in
  order when two word spans touch or overlap.
- **Gaps removed.** `cartoon_rigged` and `screen_mock` are no longer in `BUILD_GAPS`. `BUILD_GAPS` now holds react_clip and
  cartoon_generated. `BUILDABLE_TYPES` excludes the chain types (`CHAIN_TYPES`: cartoon_generated, stop_motion), so it matches
  what buildSource can build.
- **Downgrades.** `DOWNGRADE_TO.stock_footage` is `["product_hero"]`. The lead decided (2026-10-15) that 7.1's "cinematic budget
  model" means the video.budget class. product_hero is the only buildable type on that class (cartoon_generated is a gap).
  `build.ts` now sets `downgradeTo` on every shot whose type has a 7.1 fallback (`downgradeFor`), not only on generated shots.
  So a stock shot names product_hero, and a cartoon_rigged shot names kinetic_type.
- **Stop-motion and cartoon chains.** Still refused by `buildSource` with the chain's reason. Not built (see the contract note).

**Decisions for the lead (not made in code)**

1. **Generalised downgrade.** Every type with a 7.1 fallback now gets `downgradeTo`, so cartoon_rigged gets kinetic_type as well
   as stock getting product_hero. The orchestrator already downgrades a failing component that has a target, so this matches
   its design. Narrow it to generated and stock if you want only those.
2. **Sketch beats on a page with no usable rig have no candidate.** When a reference segment is `sketch_joke`, its only
   candidates are cartoon_rigged and the gapped cartoon_generated. With no rig that can draw, the plan is refused at
   `every_shot_has_a_candidate` (no model call is made). This is fail-closed, and it is better than before (the sketch always
   failed). Whether a sketch beat should fall back to kinetic_type is a proposal change (7.4), so it is your decision.
3. **The rig's mouth names.** character.rig draws `closed, open, wide, round, teeth` (`RIG_VISEMES`). The contract fixture's
   sheet uses phoneme names (`A, E, O, M, rest`), so it cannot drive the rig and is refused for it, as the test shows. The page's
   character sheet must list the rig's names, or a mapping from phonemes to the rig's shapes must be agreed. The kit UI and the
   contract owner decide that.
4. **Which rig.** `kits.characters` is loaded by the handler. Its order is not tied to `page.characterIds`, so the first usable
   rig is a guess. Please confirm the order (or pass the page's rig explicitly).
5. **Contract change for the chains (cartoon_generated and stop_motion).** This is not made in code; the lead writes it.
   - `ShotSource` (contracts/plan.ts) is one call: a union with one `kind`. A cartoon shot is two calls (image.keyframe, then
     video.budget from the keyframe, Bible 7.1). A stop-motion shot is 24 to 36 image.edit calls from the hero image, then
     `stopmotion.player`. The estimate reads `ShotSpec`, so it cannot price the keyframe or the frames, and the plan would
     under-reserve. The proposed contract: `ShotSpec.source` may be a `chain` of calls, each with its modelClass, its refs and its
     take count, and `estimatePlan` prices every call. A version bump is needed (Bible section 4).
   - Until then both stay refused (`buildSource`), and both name their chain builder (`cartoonGeneratedChain`, `stopMotionChain`).
   - stop_motion also needs `stopmotion.player`, which is not built, and image.edit is unpriced (rule 5 removes it first).
6. **The downgrade replan is still not built** (E3 open point 4). A downgrade on a stock or rigged shot is recorded as a
   target, but the plan does not re-run for it yet.

**Tests (this follow-up)**

- `align.test.ts`: `timedWordsOfShot` (relative and clamped; the fallback is spread in order and stays inside the shot; the same
  words as `wordsOfShot`). The existing `wordsOfShot` test now carries the end times the type needs.
- `sources.test.ts`: the rig's mouth from the spans; chat messages at their spans; mouth events closing at the next open;
  `componentBuildRefusals` (no refusal for a fully-kitted shot; cartoon_rigged without a sheet or with phonemes; a one-line screen
  with no product; a long chat sentence; kinetic over its limit; a product card with no kit).
- `filter.test.ts`: the pins are updated. screen_mock and cartoon_rigged are kept with their kits (the rule-4 and rule-6 lines
  were the build-gap pins). A build-time refusal removes a type with its reason. The rig kit reason is asserted.
- `tables.test.ts`: the gap pins are replaced with the opened types. BUILDABLE_TYPES excludes the chains. Stock falls back to
  product_hero, which is on video.budget.
- `minimum.test.ts`: `planKitsOf` counts a usable rig, and not the phoneme sheet.
- `character.test.ts` (new): `rigSheetProblem` and `rigSheetOf`.
- `build.followup.test.ts` (new): a sketch beat drawn as character.rig, with the mouth timed from the voice's words (exact values
  from the fixture's words); every mouth in its shot and in order; cartoon_rigged naming kinetic_type; a sketch reference with no
  usable rig refused at the filter with no model call; stock naming product_hero; the kinetic line of b1 starting at the voice time
  of "lying" (1714 ms).

**Test status (honest account)**

- Before the owner's instruction to stop test runs, `NODE_ENV=development node --experimental-strip-types --test
  'src/engine/plan/**/*.test.ts'` ran 203 tests, 203 pass, 0 fail.
- `npm run typecheck` finished once, after that run. It printed no errors (its exit code was not captured).
- `npm run lint` was not run. No test, typecheck or lint run was started after the owner's instruction.
- The lead runs every check after the phases are done. Please run `npm test`, `npm run typecheck` and `npm run lint`, and
  check the plan folder first, since build.ts, sources.ts, tables.ts, align.ts and minimum.ts changed.

**The owner's live run (agents hold no keys)**

1. A page with a rig sheet that lists the rig's names, and a reference with a sketch segment. Plan it, and record the rig
   source props, the plan gate's checks, and the cloud render (components cost $0; the ledger records the render only).
2. Check a rigged shot's mouth events against the voice's word spans in the shot (they open at each word's voice time).
3. Check the kinetic.type line times against the voice (the emphasis line starts at its word's voice time).
4. Check a stock shot's downgradeTo (product_hero) against the kit, and the rig's kinetic_type fallback.

## E5: visual-type recipes and component sources (branch `eng-e5-visual-types`)

Granted files: `tables.ts`, `sources.ts` and their tests (`sources.test.ts`, the new `tables.test.ts`). Nothing else in `plan/`
was changed, and `filter.test.ts`, `minimum.test.ts` and `build.ts` were not touched.

- **Looks (`tables.ts` PROMPT_STYLE).** cinematic, cartoon_generated and stop_motion each have one code-written look, put in
  front of the planner's scene. The looks name no text, price, logo or name. A test runs the plan gate's own text rule
  (`review/gates/promptText.ts`) on each look.
- **Chains (`tables.ts` GENERATION_CHAINS, `sources.ts`).** cartoon_generated is a keyframe call (image.keyframe, with every
  character reference, Bible 13), then a video call (video.budget, one take) that starts from the keyframe. stop_motion is 24 to
  36 image.edit frames from the hero image (8 to 12 per second, from the shot length, 2 to 4.5 s), then stopmotion.player. A
  ShotSource carries one call, so `buildSource` refuses both and names its chain builder. `cartoonGeneratedChain` and
  `stopMotionChain` build the calls for the produce step, and are tested but not yet called.
- **cartoon_rigged (`sources.ts` rigSource).** Draws `character.rig` (bean.v1). Needs a rigged sheet that lists the `idle` pose
  and the `closed` and `open` mouth shapes (else refused with the reason). The pose comes from the beat role (`tables.ts`
  RIG_PLAY, in code: the planner's output has no pose field); a pose the sheet does not list falls back to idle. Mouth shapes
  come from the words: each word opens the mouth (round for o and u, wide for e, i and y, open otherwise) and closes it at its
  end. A shape the sheet does not list falls back to open.
- **screen_mock (`sources.ts` screenSource).** Two or more sentences make a chat (alternating sides, up to six messages). One
  sentence with approved claims makes an app screen (the product name, the claims as rows, the hero picture). One sentence with
  no claims makes a notification (the product name as the app, the sentence as the headline, the hero as the icon). No product
  name for a one-line screen is a refusal, and so is a shot with no words.
- **kinetic_type (`sources.ts`).** A shot that speaks emphasis words is drawn by `kinetic.type`, with its lines timed by the
  words' spans. A shot with no emphasis is drawn by `kinetic.punchline` exactly as before (the E3 test still holds).
- **Word timings.** `SourceShot.spans` (optional, relative to the shot's start) and `BuildSourceInput.character` (optional).
  Without spans, the words share the shot's length evenly; that is only for animation timing, and the voice remains the clock
  (Bible 6.3). A span list that does not match the words is refused.
- **Build gaps (`tables.ts` BUILD_GAPS).** Texts updated. cartoon_rigged and screen_mock **keep their gap**, because
  `filter.test.ts` pins them (lines 110, 128 and 129). cartoon_generated keeps its gap, with the chain and the missing keyframe
  price as the reason. stop_motion has **no gap entry**, because `minimum.test.ts` pins its `unknown_price` reason, and rule 5
  already removes it (its image.edit price is null).

### Decisions for the lead (not made in code)

1. **Opening cartoon_rigged and screen_mock.** Their sources are built and tested, but the plan cannot choose them while their
   gaps stand. To open them: delete their two BUILD_GAPS entries in `tables.ts`, then update `filter.test.ts` (lines 110, 128
   and 129, and the rule-6 assertion for cartoon_rigged around line 148), and re-run the plan tests. That file is outside this
   grant.
2. **build.ts must pass the new inputs.** The call to `buildSource` in `build.ts` (around line 363) should pass `character` (the
   page's character sheet from the validated kits) and the shot's `spans` (the voice words' times, relative to the shot start).
   Until it does, cartoon_rigged refuses (no sheet), and the timing of kinetic.type and the rig is the even approximation.
3. **cartoon_generated is under-priced and cannot be a single call.** RECIPES bills video.budget only; the keyframe
   (image.keyframe, seedream_5_flash at $0.018 an image) is not in the estimate. Its chain needs produce_shot to make two calls
   (a contract change, owner of the contracts).
4. **stop_motion stays out.** image.edit is token-priced (price null), so its cost is unknown and rule 5 removes it. Its chain also
   needs a frame-chain step and the stopmotion.player component (not built).
5. **stock_footage's downgrade differs from Bible 7.1.** 7.1 says it falls back to a `cinematic` budget model; `DOWNGRADE_TO.stock_footage`
   is []. Not changed here (it changes which shots can be re-planned and what they cost).
6. **Behaviour changes to confirm.** (a) kinetic shots with emphasis now draw kinetic.type; (b) the cinematic prompt now starts
   with the look, so the video model receives a longer prompt for the same scene; (c) the rig's pose is set by the beat role in
   code, not by the planner (Bible 9.2 asks the planner for a timeline; the planner's contract has no pose field).
7. **Names.** Bible 9.2 calls the rig `cartoon.rig`; the lead's brief named it `character.rig`. The code uses `character.rig`.

### Tests (E5)

`NODE_ENV=development node --experimental-strip-types --test 'src/engine/compose/**/*.test.ts' 'src/engine/plan/**/*.test.ts'`
runs 387 tests, 387 pass, 0 fail, 0 skipped (the baseline before E5 was 296; the compose folder includes the hyperframes lint
tests for every fixture). The new cases are in `sources.test.ts` (chat, app,
notification, the rig's timeline and fallbacks, the chains and their refusals, the word helpers) and `tables.test.ts` (new: looks,
rig names, chain models against RECIPES, build gaps, downgrade paths).

### Owner's live run for E5 (agents hold no keys)

The three new component sources (cartoon_rigged, screen_mock, the emphasis form of kinetic_type) have no provider cost, so the
only paid part of their live run is the cloud render. The owner runs, after decisions 1 and 2:
1. One cartoon_rigged shot and one screen_mock shot through a real plan (the reference's beats, a page's character sheet, the
   product kit), and records the plan gate's checks, the source props and the cloud render (components cost $0; the ledger
   records the render only).
2. The kinetic.type shot from a real script with emphasis, with real voice spans, to check the line timing against the voice.
3. Nothing for cartoon_generated or stop_motion until their chains have a produce step and prices.

## E3 integration pass (branch `eng-e3-wiring`)

- **Director beat text (lead decision 6, Bible 7.7).** `DirectorChoice.beatText` (optional) is set in `build.ts` from the beat's script
  text, and `runDirector` sends it in the director's table. The director call is the only one that sees script text, as untrusted data.
  The planner still never sees it. The director's prompt edits are still refused when they ask for text (`applyDirectorCheck`).
- **Prompt:** the director reads `director_check@2.md` (see `../claude/STATUS.md`).
- **Test change:** `build.test.ts` no longer asserts that the director sees no script words. It asserts that the planner sees none, and
  that the director's table carries the beat text inside an untrusted block.
- **Intake and the plan classify the same must requests** (see `../jobs/STATUS.md`, item 2): when the inputs match, the plan resumes
  intake's answer through the journal.
- **Lease:** the plan stage's lease is three Claude leases (`registry.ts`, `timeoutFactor: 3`). The config owner should add
  `thresholds.jobs.leaseMs.plan`.

Branch `eng-e3-plan`, cut from `code/beautiful-cori-1zfk11` (aa3bcf8). Covers Bible 6.4 steps 1 to 7, section 7 steps 1 to 5,
the request classifier (7.3) and the plan handler. Built on the E1 steps 1 to 4 (`visual.ts`, `filter.ts`, `score.ts`, `fit.ts`,
`cost.ts`, `minimum.ts`), which are changed only where the list below says so.

## Built (E3)

- **Steps 1 and 2 (`align.ts`):** each beat aligned to a reference segment (role first, then nearest relative centre; a beat
  whose role no segment has is aligned by position alone, and says so). Each beat split along the grammar's shot-length curve
  (the curve value at the beat's centre is the target, held within `thresholds.edit.shotLengthMinMs` and `shotLengthMaxMs`, and
  cut into the nearest count, split evenly in whole milliseconds). The pieces tile the voice exactly. Shot ids are deterministic.
  Shot flags: showsProduct (a real_product request on the beat), textInPixels (a request asks to see words), handsOnProduct (a
  hands request on a product beat).
- **Step 1 (filter) extended:** rule 6 also removes the build gaps (below) and the per-shot refusals (a component whose text limit
  the shot's own words exceed). Rule 2 refuses stock on a product beat (L8).
- **Step 4 (`sources.ts`):** each shot's source from its final type. Component props are checked against the library's own
  schema, with the reserved durationMs.
- **Step 5 (`director.ts`):** `applyDirectorCheck` is pure. A swap must be one of the shot's candidates and keep the plan within
  the request budget (checked in order, against the choices made so far). A prompt edit must be on a generated shot and ask for
  no text. Anything else is ignored and logged as a Decision `by: "director"`. The approval is logged.
- **Planner (`claude/roles/planner.ts`, `prompts/planner@1.md`):** one Opus call per plan, for every shot that may be generated (a
  prompt) and every shot that may be stock (a query). A prompt that asks for text is refused by the answer contract, so the
  retry names the path and the rule, never the model's words.
- **Director (`claude/roles/director_check.ts`, `prompts/director_check@1.md`):** one Opus call. The answer has three keys and no
  free text. Shot ids and type names are checked in code, not in the schema, so an out-of-bounds swap parses and is ignored.
- **Request classifier (`claude/roles/request_classifier.ts`, `prompts/request_classifier@1.md`, `classify.ts`):** Haiku, one call
  per request set. `classifyVisualRequests(deps, input)` is the function intake's `classify` port should call (see open point 1).
- **Plan gate (`build.ts`):** `checkPlan` (review/gates/plan.ts, unchanged), with the handler's checks in front: the kits that
  loaded match the validated versions, the planner and director answered, and every source was built.
- **Handler (`jobs/handlers/plan.ts`):** reads validated_request, video_dna and voice_track; loads kits through a port; classifies;
  plans; writes the scene_plan artifact (parents: the three inputs) whether or not the gate passes; returns the plan output with
  its shot summaries. It refuses without a reservation, and it refuses a downgrade directive (not built, below).
- **Downgrade:** every generated shot has `downgradeTo` (the first chain target the shot can take as it stands), or none, and the
  gate refuses it.

## Changed E1 code (and why)

- `tables.ts`: `BUILD_GAPS`, `BUILDABLE_TYPES`, `KINETIC_WORDS_PER_LINE` added. Gaps are data.
- `filter.ts`: `kitRejection` includes the build gaps (reason: "no source can be built for it yet"); `productPixelRejection`
  refuses stock on a product beat; `filterCandidates` takes `refusals`.
- `filter.test.ts`: the rule-4 assertion that screen_mock survives is now that it is removed by its gap; the rule-6 assertion that
  cartoon_generated is not kit-rejected now checks the gap reason. Both are E3 build gaps, so the change is intended.
- `minimum.ts`: `planKitsOf` counts a product kit with no image as absent (`product.ts`). Intake's minimum uses the same rule.
- `visual.ts`: `ShotChoice.candidates` (each survivor with cost and score). `types.ts`: `ShotInput.refusals`.

## Build gaps (E3 buildable set: ugc_presenter, product_hero, stock_footage, cinematic, kinetic_type, coded_graphics)

`cartoon_rigged` (rig component not in the E3 library), `react_clip` (no owned or licensed clip source), `screen_mock` (chat
component not in the E3 library), `cartoon_generated` (its style keyframe is a second paid call that one shot source cannot
carry). `stop_motion` stays out by its unknown price. The lead decides whether the gaps are right; they remove options the
E1 pool had.

## Tests (this worktree)

Run: `NODE_ENV=development node --experimental-strip-types --test 'src/engine/plan/**/*.test.ts' 'src/engine/claude/roles/*.test.ts' src/engine/jobs/handlers/plan.test.ts`

- Final run (E3, this branch): 208 tests, 208 pass, 0 fail. The run covers the plan folder, the three roles, the handler, and the
  Claude boundary and prompt-load tests.
- `build.test.ts` (14): the five required cases (the fixture plan tiles the voice exactly; a must is always honoured; an
  out-of-bounds swap is ignored and logged; a budget covering only the fixed cost gives an all-code plan; no text in generation
  prompts, with the text refused and the retry not repeating it), plus: an applied swap, the director answer refused for prose,
  the planner and director never sent the script's words, the planner's refusal at a small budget, and a decision per alignment,
  split and choice.
- The role tests check each contract, its estimate at the Bible's Claude rate (Opus $4/$20, Haiku $1/$5), its four prompt sections
  and the pinned bytes of each prompt (`load.ts` pins: a prompt edit is a new version).
- Boundary tests still pass: `claude/boundaries.test.ts`, `review/boundaries.test.ts`, `prompts/*.test.ts`.
- `npm run typecheck`: exit 0. `npm run lint`: 0 errors (4 warnings in `src/components/`, not touched; none in engine code).

## Deviations from the Bible (for the lead to accept or reject)

1. **The director's answer has no reason, and the planner's answer has no notes (7.7, 11.2).** Bible 7.7 shows `reason` on each
   swap. A reason is model prose that a Decision would store, so the code writes every reason from the rule that broke. This
   matches the critic's contract (CLAUDE.md rule 8).
2. **The director and the planner never see the script's words (7.7 lists "beat text").** A visual choice needs the beat's role
   and the viewer's requests, and a prompt must not carry words to render (L8). The director sees beat roles, the requests and
   the planner's prompts (as data). If you want beat text in the director's table, the answer still cannot carry it back.
3. **The planner writes for every shot that may be generated or stock, not only the chosen type.** A director swap then stays
   inside the shots' candidates with its source already written. The output stays within the planner's 4k-token cap for the
   fixture (an estimate of 20k in, 4k out).
4. **`request_classifier` output cap is 300 tokens (Bible 11.1: 0.2k initial).** A request set with many items needs more; 300
   costs about $0.0005 more per call.
5. **Director `ok: false` does not block.** The plan gate does not read the director's verdict (Bible 6.4 step 7 names the
   checks it validates). The verdict is a Decision. Say if it should be a check.
6. **Shot lengths are split per beat (curve value at the beat centre), not per shot.** Equal pieces within the beat, held to the
   limits in config.
7. **`planKitsOf` changed (product kit with no image counts as absent).** Intake's minimum now uses the same rule, so the minimum
   and the planner agree.

## Open points for the lead

1. **Intake's classifier has no reservation.** `classifyVisualRequests` makes a paid call, and a call needs a `res_` reservation
   (Bible 14.1). Intake does not reserve (handlers/STATUS.md blocker 1). Wire intake's `classify` port to call the function with a
   reservation. Until a reservation exists, the port returns no classifications, so every must fails its check (fail closed).
2. **The plan job runs up to three Claude calls under one 2-minute lease (Bible 5.1).** The calls are classification, planner and
   director, each with its own timeout (60, 110 and 90 seconds). A lease expiry retries the job, and the journal then resumes any
   answer already stored (wire `RoleCallJournal`). The lease class for this stage is a decision.
3. **The plan needs a reservation at plan time, and none exists yet.** `payload.budgetReservationId` is set only after
   estimate_reserve, which runs after the plan (blocker 1 again). The handler refuses without it, so nothing is called unreserved.
4. **Downgrade replan is not built.** `details.directive === "downgrade"` throws not_implemented. The orchestrator queues it for
   a failed generated shot (E4 routing). The E3 code for it is `downgradeFor` plus a planner call for one shot.
5. **Constants that are not in config.** Structural values: `KINETIC_WORDS_PER_LINE` (4, tables.ts), the product card's three
   bullets (sources.ts), and the alignment rule (role, then nearest centre, with no weight). The role timeouts (60, 110, 90 s)
   follow the critic's pattern in the role files. Move them into config if you want them tuned.
6. **The E1 open points still stand:** the plan tables are in `tables.ts` (the lead decides whether they move to config); the
   $0.50 budget cannot deliver (fixed lines are $0.52, the owner decides the minimum); banned style types are a score term, not a
   filter; `image.edit` is unpriced so `stop_motion` is never chosen; the real-person consent check has no contract field.

## Files outside `plan/` (under the grant)

- `src/engine/claude/roles/request_classifier.ts`, `planner.ts`, `director_check.ts` and their tests.
- `src/engine/prompts/request_classifier@1.md`, `planner@1.md`, `director_check@1.md`.
- `src/engine/jobs/handlers/plan.ts` and `plan.test.ts`.

Not touched, as the grant says: `jobs/handlers/STATUS.md` and `claude/STATUS.md`. The notes above are the text for them. Contracts,
config, review gates, intake, the orchestrator and the gateway are unchanged.

## Live run: owner (no keys held by agents)

No agent holds a key, so nothing here has run against a provider. The owner's run, once intake's classifier and the plan
reservation are wired (open points 1 and 3):

1. Intake the fixture request ($4, `ig:reel/FIXTURE0001`) with the production kits, and classify its visual requests with the
   request_classifier role. Record the classifier's answer, its ledger entry and its cost.
2. Run the plan stage on the same validated request, its VideoDNA and its voice track, with the reservation. Record the planner's
   and the director's answers, their ledger entries and costs, and the scene_plan artifact id.
3. Check the plan gate's checks, the shot list (13 shots from 5 beats for the fixture), the director's decisions and the shot
   lengths against the reference's curve (the E3 acceptance: edit grammar within 15 per cent of the reference, once edit exists).
4. Run the same request at a budget of $0.52 and record the all-code plan and its gate.
5. Replace the fixtures in `test/fixtures/` with the recorded answers, and check that the shot ids still match the plan.
