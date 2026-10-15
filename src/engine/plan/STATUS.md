# STATUS: the plan stage (W7), E3 and E5 (W9 plan-side support)

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
