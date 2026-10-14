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

## Live run: owner (no keys held by agents)

Nothing here calls a provider. The owner-only items are these:

1. Label gold sets. There are no labels in the repository. Until a check has 100 failing and 100 passing labels, and meets
   recall 0.90 and false-fail 0.10, its failures route to review. The owner (or review decisions) writes them. The
   `request` and `plan` checks are the first candidates.
2. Confirm `thresholds.plan.shotTilingToleranceFrames` (1 frame) and `thresholds.intake.speechOverrunShare` (0.1).

## For E4 (not built here)

- **Take gate** (12.2): the code checks (duration, frozen frames, flicker, motion, text by OCR), the similarity checks (product
  and persona embeddings, palette), and the Haiku slop rubric. The rubric is a Claude call, so it waits for the client.
- **Pre-render gate** (12.3, `pre_render`): slideshow risk (`slideshowRisk.ts`, six dimensions, weighted mean below
  `thresholds.postRender.slideshowRiskMax`), the delivery promise, safe zones, caption rules, rights records, disclosure
  flags for AI people (the wording is open in 20.2; the flag is carried, the wording is not written), and budget left
  for render. Also `edit` gate (8.3) and the take gate's `TakeVerdict` assembly.
- **Render integrity** (12.3): the ffprobe checks against the EDL. The platform size limit is `null` in config, so the size
  check must refuse to pass until the owner sets it.
- **Post-render review** (12.3, `post_render`): frames at cuts and at 10, 35, 65 and 90 per cent, loudness, true peak,
  silence, caption timing, on-screen claims, and `critic_final` (a Claude call).
- **Critic** (`critic.ts`) and sampling (`sampling.ts`, 6.14 and 12.5): these need the Claude client and the review
  inbox. The inbox wiring into Meridian's existing review queue is also E4 work.
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
