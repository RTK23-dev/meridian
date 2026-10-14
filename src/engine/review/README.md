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
