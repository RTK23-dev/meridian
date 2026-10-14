# Review gates (W11, pre-production)

Implements Video Engine Bible **section 12** (quality system), with **12.1** (gates before production), **12.4** (gold
sets and accuracy targets) and **5.3** (gates: a gate returns a `GateResult`, the orchestrator routes it). Section 6.1
(intake steps 1 to 7) is the basis of `gates/request.ts`, and 6.10 (`pre_render_gate`) names the failing shots this round
returns. Status and what E4 still needs: `STATUS.md`.

## Files

- `gates/common.ts`: `check()`, `notEvaluated()`, `gateResult()` (builds and validates a `GateResult`), `EDL_FPS`.
- `gates/request.ts`: `checkRequest(input)`. Schema, kits and their versions, claims, speech length, VideoDNA lookup,
  format minimum, every `must` deliverable, and forbidden terms from the product kit.
- `gates/plan.ts`: `checkPlan(input)`. Tiling, `must` classified and satisfied, no text in generation prompts, product
  beats use real imagery, every generated shot has a downgrade, estimate within budget. Names failing shots.
- `gates/budget.ts`: `checkBudget(reservation)`. Reservation succeeded, not paused, cap mode, reservation covers the
  estimate.
- `gates/promptText.ts`: the heuristic that finds a generation prompt asking for rendered text.
- `gold.ts`: the gold-set format (`meridian.gold_label/v1`), its loader, the recall and false-fail metrics, and
  `decideGate`, which routes a result to `pass`, `block` or `review`.

Take gate (Bible 6.7 and 12.2, E2):

- `gates/take.ts`: `takeGate(input)`. Pure. Combines the code, similarity and Critic rows into a `GateResult` (gate `take`)
  and a `TakeVerdict`, with routing `accept`, `redo` or `escalate`. Also `pickBestTake(verdicts)` for two takes of a shot.
- `take/code.ts`: `codeRows(shot, measurements)`. Duration within the tolerance, no black or frozen run over the limit,
  flicker below its limit, and motion for a shot that must move. Measurements come from the media functions.
- `take/similarity.ts`: the `SimilarityScorer` interface, `notConnectedScorer()` (the default, NOT_CONNECTED), and
  `scoreSimilarity` / `similarityRows` for product against hero, persona against portrait, and palette against the kit.
- `critic.ts`: `runCritic(deps, request)` runs the `critic_take` role (`claude/roles/critic_take.ts`) through `runRole`, and
  `criticRows(outcome)` turns the seven rubric scores and the confidence into rows.
- `take/types.ts`: the shot, the frames, the similarity kinds, the gold keys (`TAKE_GOLD_KEYS`) and the `TakeRow` shape.
- `take/gold.ts`: `loadTakeGold(text)`, the gold-set loader for take checks (labels are JSON, one check each, with the input
  the check runs on), and `takeGoldMetrics(labels)`.
- `takeCheck.ts`: `runTakeCheck(deps, request)`. The async steps: similarity, the Critic, then `takeGate`. The job handler
  that calls it is the pipeline's.
- `inbox.ts`: `takeReviewItem(input)`, the typed escalation payload for the review inbox (every take, its checks, the plan
  artifact id, and the five reviewer actions of 12.5). The inbox wiring is the lead's.

## Take routing (gates/take.ts)

- Every check passes: `accept`.
- A check has no evidence (a null measurement, a scorer that is not connected, no Critic answer), or the Critic's confidence
  is below `thresholds.escalation.criticConfidence`: `escalate`. Missing evidence is never a pass and never a block.
- Measured failures, and one of them has a gold set that meets the target: `redo`, with the failing rule names as hints.
- Measured failures with no gold set that meets the target: `escalate`. The downgrade is the orchestrator's (5.3).
- A rubric item is a check of the shared `take:slop_rubric` gold set. The Critic's confidence check has no gold set, so it
  only escalates.

## Rules the code follows

- **Unknown means fail.** A missing kit, classification, minimum, lookup or input is a failing check with a detail. A
  schema-invalid input fails `schema_valid` and every other check is marked not evaluated.
- **Shot ids on failure.** A failing check that is about shots puts those ids in `failingShotIds`. Only those shots go back
  to `plan` or `produce_shot` (6.10).
- **Blocking needs proof (12.4).** A failing check blocks only when its gold set has at least 200 labels (100 that should
  fail and 100 that should pass), recall at least 0.90 and a false-fail rate at most 0.10. Otherwise the failure goes to
  review. All the numbers come from `config/thresholds.ts` (`goldSets`) and `plan.shotTilingToleranceFrames`.
- **Tiling tolerance.** One frame at `EDL_FPS` (30), that is 33.3 ms. The fps is the contract literal in `edl.ts`, and a
  test keeps the two equal.
- **Prompt text is a heuristic.** Its failures route to review until its gold set is met. A negation (no, without, free
  of) that governs a cue word clears it.

## Tests

`NODE_ENV=development node --experimental-strip-types --test 'src/engine/review/**/*.test.ts'`. Each check has a fixture
pass and at least one mutation that fails it. The gold tests cover the exact thresholds, sample-size floors, and routing.

The take gate's fixtures are in `test/fixtures/`: recorded Critic answers in the OpenRouter shape, recorded measurements,
recorded similarity scores (a clean take and a warped product), and an authored gold sample. `test/helpers.ts` has the
recorded transport, a ledger with one reservation and a recorded scorer. The authored gold sample is not an owner label.
