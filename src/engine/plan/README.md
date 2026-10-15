# The plan stage (W7): Video Engine Bible 6.4, section 7, and the request classifier of 7.3

Implements the plan stage of Bible 6.4 (steps 1 to 7) and the five-step visual decision of section 7 (filter, map musts,
propose, score, fit the budget, and the director check). Steps 1 to 4 of the decision are pure code. Step 5 is one Opus
director call. The planner (one Opus call) writes the prompts and queries that the sources need. Status and the owner's
live run are in `STATUS.md`.

## Files

Pure code (no network, no store):

- `align.ts`: steps 1 and 2 of 6.4. `alignShots` aligns each beat to a reference segment (role first, then nearest relative
  centre), splits each beat along the grammar's shot-length curve, and sets the shot flags (7.2 rules 2 to 4) and the
  component refusals. Shot ids are deterministic (`shotIdFor`).
- `visual.ts`: `decideVisuals`, steps 2, 1, 3 and 4 of section 7. Each shot's result also lists its surviving candidates with
  their cost and score (`ShotChoice.candidates`), which the director step needs.
- `filter.ts`: step 1, the six rules of 7.2. Rule 6 (`kitRejection`) includes the E3 build gaps (`tables.ts`) and the
  per-shot refusals (text a component cannot hold). Rule 2 also refuses stock on a product beat (L8).
- `propose.ts`, `score.ts`, `fit.ts`, `cost.ts`: the candidate pool, the score U(s, t) and the budget fit, as in E1.
- `minimum.ts`: the format minimum (intake, 6.1 step 6). `planKitsOf` counts a product kit with no image as absent.
- `product.ts`: the product's image set and the hero frame (front, else first hero, else first cutout).
- `sources.ts`: step 4, the source of each shot from its final type. Component props are checked against the library's own
  schemas (`compose/components`), so a shot the library cannot draw is refused here.
- `prompts.ts`: the task inputs of the planner and the director. Neither carries the script's words, a product name, a claim,
  a price or fetched text.
- `director.ts`: step 5, `applyDirectorCheck` (pure). Each swap must be one of the shot's own candidates and keep the plan
  within the request budget. Each prompt edit must change a generated shot and ask for no rendered text. Anything else is
  ignored and logged as a `Decision` with a reason that the code writes. `runDirectorCheck` makes the one call.
- `build.ts`: `planScene`, the whole plan. It returns a `GateResult` on every path. A plan that cannot be built is refused
  with the check that stopped it, and nothing is returned for it. A built plan is returned with the plan gate's checks (12.1),
  and it may still fail that gate with its failing shots named (6.10).
- `tables.ts`: the plan tables, `planTables@1` (see `STATUS.md`), plus `BUILD_GAPS`, `BUILDABLE_TYPES` and
  `KINETIC_WORDS_PER_LINE` (E3).
- `character.ts`: the page's rig sheet (`rigSheetOf`, `rigSheetProblem`). A sheet drives character.rig only with the rig's own
  pose and mouth names (Bible 13, 9.2). `minimum.ts` and `build.ts` read the same rule.
- `types.ts`, `fixtureInputs.ts`: shared types and the E1 fixture inputs.

Claude calls (through the Claude client, `claude/client.ts`, only against a reservation):

- `classify.ts`: `classifyVisualRequests`, the request classifier (7.3). Intake and the plan stage call it. A refused or
  duplicate call is `not_classified` with a reason. Nothing is guessed.
- `../claude/roles/request_classifier.ts`, `planner.ts`, `director_check.ts`: the three roles, with prompts
  `../prompts/request_classifier@1.md`, `planner@1.md` and `director_check@1.md`. Every answer is a strict zod contract with no
  free text (the planner's prompt and query are the only text, and the planner's prompts are checked for rendered text).

## The rules the code follows

- **The must (7.3):** a must keeps only the types that can deliver every one of its properties. Every shot of the must's
  beat is held to that set, and each such shot says it satisfies the request. Director swaps cannot leave the set (they must
  be candidates).
- **Text (L8, 7.2 rule 3):** text is never drawn by a model. A generation prompt that asks for text, a sign, a logo, a
  caption or a price is refused by the planner's answer contract, and the retry names the path and the rule only. A request
  that asks to see words in the picture makes its beat's shots text in pixels, so no generated type can serve them.
- **Product (L8, 7.2 rule 2):** a product beat shows real imagery. Its generated shots pin the hero frame. A product card draws
  the product's name, claims and hero image from the kit. Stock is not a candidate on a product beat.
- **Build gaps (E3):** `cartoon_rigged`, `react_clip`, `screen_mock` and `cartoon_generated` have no source yet. Rule 6 removes
  them from every shot and from the minimum, with the reason written in the rejection. `stop_motion` has no known price, so
  rule 5 removes it.
- **Downgrade (6.4 step 5, 7.1):** every generated shot names the first target of its downgrade chain that the shot can take
  as it stands (`downgradeFor`). No target means no `downgradeTo`, and the plan gate refuses the shot.
- **Director (7.7):** one call. Swaps are applied in order and checked against the choices made so far. A swap that breaks
  the rules is a `Decision` with `by: "director"` and no change. The approval (`ok`) is recorded and does not itself block.
- **Decisions (L7):** every alignment, every split, every scorer choice, every director swap or edit (applied or ignored) and
  the approval are `Decision`s with a reason.
- **Determinism:** the same inputs and the same recorded answers give the same plan, the same shot ids and the same plan id.

## Tests

`NODE_ENV=development node --experimental-strip-types --test 'src/engine/plan/**/*.test.ts' 'src/engine/claude/roles/*.test.ts' src/engine/jobs/handlers/plan.test.ts`

- `build.test.ts`: the fixture plan tiles the voice exactly and passes its gate; the must is honoured; a director swap that breaks
  the must is ignored; an applied swap is logged; five out-of-bounds swaps and edits are ignored and logged; the planner and
  the director never see the script's words; a prompt that asks for text is refused and the retry never repeats it; a budget
  covering only the fixed per-master cost gives an all-code plan (no generated shot); a budget that does not cover the planner
  call gives no plan.
- `align.test.ts`, `sources.test.ts`, `director.test.ts`, `classify.test.ts`: the pieces alone.
- `../claude/roles/*.test.ts`: each role's answer contract, its estimate at the Bible's rate, its prompt sections, and the pinned
  bytes of its prompt file (a change is a new version, Bible 11.3).
- `../jobs/handlers/plan.test.ts`: the stage on PGlite: the scene plan artifact and its parents, the output contract, the
  refusal without a reservation, and a classifier refusal that writes nothing.

Recorded answers are in `test/fixtures/` (see its README). They are authored in the OpenRouter shape; the owner's live run
replaces them.
