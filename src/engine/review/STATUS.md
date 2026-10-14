# STATUS: review gates, pre-production (W11)

Phase E1, wave B. Branch `engine/e1-w7-w11`, cut from `code/beautiful-cori-1zfk11` (which contains wave A). Covers
`src/engine/review/`: the three pre-production gates (`request`, `plan`, `budget`), the gold-set loader and routing.
Pure code, fixture-tested. No Claude call and no store access.

## Done

- `gates/request.ts` (12.1 and 6.1 steps 1 to 7): schema, kits resolved and at the version intake used, claims approved,
  speech within `maxMs` plus `thresholds.intake.speechOverrunShare`, VideoDNA lookup agrees with the validated request,
  format minimum, every `must` deliverable (intersection of its properties' types), forbidden terms from the product kit.
- `gates/plan.ts` (12.1): tiling within one frame, `must` classified and satisfied, no text in generation prompts,
  product beats use real imagery, every generated shot has `downgradeTo`, estimate within budget (through
  `estimatePlan`, which refuses an unknown price and names its shot), and the plan's `estimatedUsd` matches its shots.
  Failing shots go in `failingShotIds`.
- `gates/budget.ts` (12.1): reservation succeeded, not paused, cap mode (`budgets.productionMode`), and the reserved total
  equals the estimate plus the redo allowance.
- `gates/promptText.ts`: a heuristic for a generation prompt that asks for rendered text. Negations, including a list
  under one negation ("free of text and signs"), clear a cue.
- `gold.ts`: `meridian.gold_label/v1` (typed labels, `parseGoldLabels`, `loadGoldLabelsJson`), `goldMetrics` (recall and
  false-fail), and `decideGate`, which returns `pass`, `block` or `review`. A check blocks only when its gold set meets the
  targets. Otherwise it goes to review.
- `gates/common.ts`: `check`, `notEvaluated`, `gateResult` (validated against `gateResultSchema`), `stringsIn`, `EDL_FPS`.

## Tests (run in this worktree)

- `NODE_ENV=development node --experimental-strip-types --test 'src/engine/review/**/*.test.ts'`: 71 pass, 0 fail.
- Each check has a fixture pass and a mutation that fails it. The plan gate's failing shot ids are asserted by name.
- Gold tests: exactly 0.90 recall and 0.10 false-fail on 200 labels block; 0.89 and 0.11 do not; 199 labels never block;
  200 labels with 50 failing examples never block; a missing rate never blocks; a proven failure blocks even with an
  unproven one beside it.
- `npm run typecheck`: exit 0. `npm run lint`: 0 errors (4 pre-existing warnings in `src/components/`, not touched).

## E2: take gate (branch `eng-e2-take-gate`, cut from `code/beautiful-cori-1zfk11` at a4b04c7)

Built on fixtures. Nothing calls a provider. The lead merges; nothing is pushed.

### Done

- `claude/roles/critic_take.ts` and `prompts/critic_take@1.md` (the two files granted for this task). Role `critic_take`,
  capability `llm.check` (Haiku), exactly six frames (`thresholds.take.rubricFrames`), the seven slop-rubric items of 12.2
  (`SLOP_RUBRIC_ITEMS`) and a confidence, all 0 to 1. The answer schema is strict: no unknown keys, so no free text. The
  estimate is 8k in and 0.5k out, $0.0105 at Haiku's rate (Bible 11.1 gives about $0.01).
- `review/take/code.ts`: duration within `thresholds.take.durationTolerance` of the planned shot, longest black or frozen
  run at most `blackOrFrozenFramesMax`, flicker strictly below `flickerMax`, and motion strictly above `motionMin` for a shot
  with `motionRequired`. Measurements are a typed interface (`TakeMeasurements`), each field nullable.
- `review/take/similarity.ts`: the `SimilarityScorer` interface, `notConnectedScorer()` (returns `not_connected` with the
  Bible 20.2 reason), and `scoreSimilarity` / `similarityRows` for product against hero, persona against portrait and
  palette against the style kit, limits from config. A scored answer outside 0 to 1 throws a provider error.
- `review/critic.ts`: `runCritic` runs `critic_take` through `runRole` on the request's reservation. A frame set that does not
  match the contract, a refused call and a duplicate call are `not_answered`. A role answer that fails twice throws
  `RoleAnswerError`, so the stage fails and the job retries it. `criticRows` turns the outcome into rows.
- `review/gates/take.ts`: `takeGate(input)`, pure. Returns the `GateResult` (gate `take`) and the `TakeVerdict`, which agree on
  `pass`, plus the proven, unproven and missing rule names and a one-line reason. Also `pickBestTake(verdicts)`: the highest
  confidence among passing takes, the lower take id on a tie (the orchestrator orders its round the same way).
- `review/take/gold.ts`: `loadTakeGold(text)` loads a JSON gold set. A label that names a non-take check, or whose input does
  not match its check, is `invalid_input` and names the label. `takeGoldMetrics(labels)` gives the metrics of each of the eight
  take gold keys, recomputed with the gate's own rule (`predictTakeFail`).
- `review/takeCheck.ts`: `runTakeCheck(deps, request)`, the async steps around the gate: similarity, the Critic, then the gate.
- `review/inbox.ts`: `takeReviewItem(input)`, a typed escalation payload (`meridian.take_review/v1`): the shot, the plan
  artifact id (null when not stored), every take with its checks, the failing rule names, and the five actions of 12.5.
- `review/boundaries.test.ts`: no `fetch`, no environment or key read, no logging, no Meridian, research, embeddings or Hypit
  import, and no import of another folder's test helper.
- Fixtures in `review/test/fixtures/`: four recorded Critic answers in the OpenRouter shape (clean, hands 0.35, unsure at
  0.45, an answer with an extra key), recorded take measurements (clean, black frames, flicker, static shot, too long, probe
  missing), recorded similarity scores (clean and warped product at 0.41), and an authored gold sample of eight labels.

### Routing (the rules the tests pin)

- Every check passes: `accept`. The verdict's confidence is the Critic's.
- Any check without evidence (a null measurement, a scorer not connected, a Critic with no answer): `escalate`. A missing
  check never blocks, even when its gold set meets the target.
- The Critic's confidence below `thresholds.escalation.criticConfidence` (0.6): `escalate`. A Critic with no answer has
  confidence 0 on the verdict, so the take escalates.
- Measured failures only, and one has a gold set that meets the target (12.4): `redo`, with the failing rule names as hints.
- Measured failures with no proven gold set: `escalate`, so the warped product in a run with no product gold set goes to
  review. It fails the gate (`pass` false); it is not redone until the product gold set is proven.
- The gate never returns `downgrade`. The orchestrator decides that after two redos.

### Tests (run in this worktree)

- `NODE_ENV=development node --experimental-strip-types --test 'src/engine/review/**/*.test.ts' src/engine/claude/roles/critic_take.test.ts`:
  189 pass, 0 fail (the existing 71 review tests included). The new tests: `take/code.test.ts` (12), `take/similarity.test.ts`
  (17), `take/gold.test.ts` (8), `critic.test.ts` (12), `gates/take.test.ts` (31), `takeCheck.test.ts` (12), `inbox.test.ts`
  (7) and `boundaries.test.ts` (6), plus `claude/roles/critic_take.test.ts` (13).
- `npm run typecheck`: exit 0. `npm run lint`: 0 errors, 4 pre-existing warnings in `src/components/`.
- Not run: the full `npm test` (the lead runs it after merging).

### Decisions for the lead

1. **File name.** The gate is `gates/take.ts`, following the `gates/<gate>.ts` convention and the gate id `take`, not
   `takeGate.ts` as the brief named it. It exports `takeGate`.
2. **Every check needs gold to block, including the duration check.** Following your rule, the code checks have gold keys. The
   duration check has no learned threshold, so Bible 12.4 may not require it. Confirm, and I will exempt it with a test.
3. **Rubric items.** Each of the seven items is its own check (so a hint names the defect) and all share one gold set,
   `take:slop_rubric`, as 12.4 asks for one gold set per Claude check.
4. **Confidence is an escalation, not a block.** `critic_confidence` has no gold set. It can only escalate.
5. **Motion shots are the planner's call.** `motionRequired` is a required input on the shot. The gate does not default it.
6. **The shot's visual type is not used to decide motion** and the planner must set `motionRequired` for every take.
7. **Two takes with the same frames are one Critic call.** The Critic's key is the hash of its input (the shot, the take
   duration and the frames). A second call with the same input returns `duplicate`, so the job reuses the stored answer.
   This is correct for identical clips, but a job that reruns a take must reuse its artifact.
8. **Constants in the role file.** The output cap (500), the estimate (8k / 0.5k) and the timeout (60 s) are in
   `critic_take.ts`, as `segmenter.ts` does. They belong in `config/prices.ts` and `config/thresholds.ts` (eng-contracts).

### Not built, and why

- **OCR for generated text** (12.2 "Generated text", limit 0 words). No OCR function exists in `functions/ffmpeg/`, so the
  check is not in the gate, and `thresholds.take.generatedWordsMax` is unused. The Bible 6.7 slop list also names "gibberish
  text" and "artefacts". The 12.2 rubric has seven items and no text item; the text check needs OCR (W4).
- **Black or frozen frames, flicker and optical flow** are not media functions yet. The gate takes them as typed measurements.
  Until W4 adds them, every take has missing code evidence and routes to review.
- **Similarity scorer.** No vendor is chosen (Bible 20.2) and `config/routes.ts` has no embedding capability. The default is
  not connected. A real scorer needs a route through the gateway, not local models.
- **Frame size.** The Critic gets the frames the caller passes. It does not decode PNGs to check the 768 px long side
  (`thresholds.claude.visionMaxLongSidePx`). The frames must come from `frames` requested at that size.
- **Gold labels.** No check meets the target. The bundled sample has eight labels and is authored, not owner labels. A check
  blocks only with at least 100 failing and 100 passing labels, recall at least 0.90 and false-fail at most 0.10.
- **Review inbox wiring and human labels (12.5).** `takeReviewItem` builds the payload. Writing it to `engine_review_items`
  and turning each reviewer decision into a gold label are the lead's wiring and E4 work.
- **The `check_take` job handler** that calls `runTakeCheck` and stores the verdict artifact is the pipeline's (eng-pipeline).
- **Files outside the grant.** `claude/STATUS.md` and `prompts/STATUS.md` were not edited, because they are eng-pipeline's and the
  grant covers only the role and prompt files and their tests. The role and prompt are described here.

### Live run: owner (no keys held by agents)

1. Route and verify the Critic: `llm.check` is Haiku with `verified: false` (`config/routes.ts`). Run one `critic_take` on a real
   generated take through `runCritic`. Record the model that answered, the generation id, the usage cost and the ledger row
   (estimate against actual). Check the answer parses with no retry.
2. Frames: request six frames of that take from the frames function at 768 px on the long side, and record their times.
3. Similarity: there is no scorer yet. Once one is routed, score one clean take and one warped product take, and record the
   scores against the owner's eye on both.
4. Acceptance (Bible 19, E2): one shot each for `ugc_presenter`, `product_hero`, `stock_footage` and `coded_graphics` produced,
   checked and passing; a deliberately warped product fails the take gate. Under the gold rule the warped take fails with
   `pass` false and routes to review until the product gold set is proven.
5. Gold sets: label 100 failing and 100 passing takes for `take:slop_rubric` first, then the code checks and the similarity
   checks. Load them with `loadTakeGold`, and check `takeGoldMetrics` before any check is allowed to block.

## Live run: owner (no keys held by agents)

Nothing here calls a provider. The owner-only items are these:

1. Label gold sets. There are no labels in the repository. Until a check has 100 failing and 100 passing labels, and meets
   recall 0.90 and false-fail 0.10, its failures route to review. The owner (or review decisions) writes them. The
   `request` and `plan` checks are the first candidates.
2. Confirm `thresholds.plan.shotTilingToleranceFrames` (1 frame) and `thresholds.intake.speechOverrunShare` (0.1).

## For E4 (not built here)

- **Take gate** (12.2): built in E2 (see above), except the OCR text check and the media functions for frozen frames, flicker
  and motion.
- **Pre-render gate** (12.3, `pre_render`): slideshow risk (`slideshowRisk.ts`, six dimensions, weighted mean below
  `thresholds.postRender.slideshowRiskMax`), the delivery promise, safe zones, caption rules, rights records, disclosure
  flags for AI people (the wording is open in 20.2; the flag is carried, the wording is not written), and budget left
  for render. Also `edit` gate (8.3) and the take gate's `TakeVerdict` assembly.
- **Render integrity** (12.3): the ffprobe checks against the EDL. The platform size limit is `null` in config, so the size
  check must refuse to pass until the owner sets it.
- **Post-render review** (12.3, `post_render`): frames at cuts and at 10, 35, 65 and 90 per cent, loudness, true peak,
  silence, caption timing, on-screen claims, and `critic_final` (a Claude call).
- **Critic for final renders** (`critic_final`, 12.3) and sampling (`sampling.ts`, 6.14 and 12.5). The take Critic is built
  (`critic.ts`). The inbox wiring into Meridian's review queue is still open (`inbox.ts` builds the payload).
- **Routing:** the orchestrator (eng-pipeline) calls `decideGate(result, metricsByCheck)` and acts on the verdict. The
  metrics come from `goldMetricsForCheck(labels, check, predictFail)`.

## Open points for the lead

1. **Every check needs gold to block, including arithmetic ones.** I applied your rule to all checks, so the tiling,
   budget and schema checks route to review until labelled. A pure arithmetic check has no false fails by construction,
   and you may want it exempt. I did not add an exemption; say so and I will add one with a test.
2. **Class balance.** 12.4 says "200 labels (100 pass, 100 fail)". I require both classes at half of
   `examplesToStart` each (100 and 100), on top of the 200 total. A 200-label set that is all pass is not enough to judge
   recall. This is stricter than the brief's wording, and it is derived from the Bible text.
3. **Voice and persona consent (13)** are not checked, because the contracts carry no real-person flag. See
   `plan/STATUS.md` item 7.
4. **Forbidden terms** (`request` gate, `forbidden_terms_absent`) is beyond 12.1. It uses `ProductKit.forbidden` (13), so
   it is a policy check. It is listed here so you can keep or drop it.
5. **Fixed lines versus the request budget.** The plan gate refuses a $0.50 request budget, because the fixed per-master lines
   are $0.52 (14.2). See `plan/STATUS.md` item 2.
6. **The prompt-text check is a heuristic.** Its gold set is the only protection against false fails. Its cue list is in
   `gates/promptText.ts` and is not in config (it has no numbers).

## Blockers

None for the fixture work. Items 1 and 3 above need the owner's labels or a contract field before any check can block in
a live run.
