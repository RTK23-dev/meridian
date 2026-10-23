# Orchestrator: status

Owner direction, 2026-10-20: the orchestrating model is chosen by the user from the live OpenRouter catalog; no model is fixed in code.

## Done
- `contracts.ts`: plan (`orchestrator-plan@1`), ten step kinds, live model reference, step events. Strict zod v4.
- `catalog.ts`: parses a live snapshot; drops bad rows with reasons; refuses a snapshot with no list.
- `validate.ts`: fail-closed plan validation. Every reason is returned. A plan or category over its line is accepted with a note (D17).
- `dirty.ts`: surgical edits. Stale set, and cache keys that ignore title and wording.
- `execute.ts`: executor with injected handlers. `not_connected`, `failed`, `skipped`, `paused` (budget), `queued` and `cache_hit` are all reported as they are.
- `layout.ts`, `replay.ts`: canvas geometry and replay.
- Canvas component: `src/components/content-factory/orchestrator-canvas.tsx`.
- `run-budget.ts`: a run takes one reservation for the line less what is committed before the run (`requestBudgetUsd`), in cap mode, under an `orchestrator_run` request row. Refused when the line is reached or the workspace month is at its line. Released when the run stops. No allowance fields.
- `categories.ts` (D3): the copy, creative and voice budgets. Each is a line of its own, checked after the total.
- `production.ts`: handlers for `reference`, `analysis`, `script`, `visual`, `voice`, `video` and `avatar`. Paid steps are authorized on the run's reservation. A queued job keeps its hold until the poll settles it (D14). A step with no hold is refused unless measure mode holds it (D15).
- Migration `0110`: `orchestrator_step_outputs.body`, so a downstream step reads content, not its hash.

## The budget line (owner direction 2026-10-23, D12, D14, D15, D17)
- `envelope.ts`: `lineOf` is the lower of the plan's budget and the budget the user set. `planAskNote` is a note, never a refusal. The tolerance, the allowance functions and `positionOf` are gone.
- `execute.ts`: a paid step starts only while the committed spend is below its line AND its own hold fits within it (`positionOfLine(spent + hold, line)`). The line check runs before the handler, so a line reached before the run pauses at its first paid step whatever is wired. A category line adds both checks after the total's. A step that does not fit pauses the run before its call, and later steps do not start. The reason is D17's text, with the category name before "budget" for a category (`blockOf`, line 94). A queued step reports `queued`, is not checked, and adds no spend. A bill above the estimate is recorded as the step's cost, so an in-flight overshoot is visible.
- `run.ts`: the line is `lineOf`, the category lines are `categoryBudgetsOf`. The starting spend is the stored outputs, the failed holds and the waiting holds (`waitingHoldsByNode`). A waiting job with no recorded hold refuses the run and names its step. The waiting steps go to the executor as `queued`. A run whose spend is at the line opens no reservation: its handlers are made without one (`api.ts`), and it pauses at its first paid step. Measure mode goes to the validation, the executor and the handlers.
- `run-budget.ts`: the request budget is the line less the committed spend (no second fit check here). The workspace month must be below its budget (`committedForMonth`), refused with "workspace monthly budget reached".
- `validate.ts`: `BudgetView` is `{ estimateUsd, budgetUsd, position }`. An unpriced video or avatar step is held at its measure hold (`holdUsdOf` with the plan's own estimate cleared, so the advisory figure cannot set it) when measure mode is on, and refused as before when it is off.
- `service.ts`: the planning call's hold must fit the user's budget, or the draft is refused before any call (the plan's own budget is not known until the call answers). The month must be below its budget. A ready plan is stored with its notes: the validator's, and `planAskNote`.
- `api.ts`: no tolerance. `runPlanFor` takes `measure` (null unless passed) and passes it, with `sql`, to the production handlers. The workspace budget source is one argument.
- `policy-store.ts`: `budgetTolerance` is out of the schema, the initial policy and the writer. `policyFrom` drops a stored `budgetTolerance` key before it parses, so a row keeps its disabled families. A malformed row still resets to the initial policy.
- `src/engine/prompts/orchestrator_plan@4.md` (new), and the role runs at version 4. Rule 7 states the line and the fit; rules 1 to 6 and 8 to 10 are as in `@3`.
- `src/lib/meridian/orchestrator/actions.ts`: `budgetTolerance` is out of the policy input and the save. The run action passes no tolerance, so nothing was dropped there.
- `src/components/content-factory/orchestrator-policy-panel.tsx`: the tolerance inputs and their copy are removed. The families and the control for the default disabled family are kept.
- `src/components/content-factory/orchestrator-plans.tsx`: the two copy strings that named the tolerance now state the line and the hold.
- Shared code, used and not edited: `budget/line.ts`, `orchestrator/measure.ts`, `orchestrator/holds.ts`, and `LedgerStore.committedForRequest` and `committedForMonth` (`budget/store.ts`).

## Review checks (coordinator, 2026-10-23)
1. Waiting holds and sql/measure wiring: `run.ts` calls `waitingHoldsByNode` (line 124). `api.ts` passes `sql` and `measure` to the production handlers (lines 146 and 145). Tests: `run.test.ts` "a later run counts a job still waiting at its provider" and "a waiting job's hold can take the spend to the line" (both pass), and "a waiting job with no recorded hold refuses the run" (passes). The `api.ts` wiring has no unit test: `runPlanFor` needs the live catalog, so it is verified by reading only.
2. Measure mode: `validate.ts` `priceStep` prices an unpriced video or avatar at its hold when measure is on (line 97). `execute.ts` holds a paid step with `holdUsdOf` (line 177), and the hold must fit the line. Tests: `validate.test.ts` "an unpriced video step is refused unless measure mode holds it..." and "an avatar step on an unpriced video model..." (pass); `execute.test.ts` "measure mode holds an unpriced video..." and "a measured hold is held to the line like any other..." (pass). Planning does not reach it: see open item 1.
3. No tolerance in the fit or start checks: `grep` finds none in `execute.ts`, `run-budget.ts`, `service.ts`, `run.ts`, `validate.ts`, `api.ts` or `envelope.ts`. The only "allowance" left is the contract's `redoAllowanceUsd` (see open item 8).
4. Retired allowance fields: `run-budget.ts` writes neither `requestAllowanceUsd` nor `workspaceMonthAllowanceUsd`. Test: `run-budget.test.ts` "a run takes one reservation for what its line leaves, with no allowance fields" (passes).
5. A zero-estimate step at the line does not start: `blockOf` keeps the start check and the fit check. Tests: `execute.test.ts` "a zero-estimate paid step at the line does not start..." (pass) and "a zero-estimate paid step below the line starts..." (pass).

## Tests
- Orchestrator folder: 247 tests, 246 pass. One fails, and it fails on the base commit too: `production.test.ts` "a call past the request budget is not made" (line 159). It expects a call above the request line to be refused. D12 starts a call below the line, and the brief path's reservation check is being made strict elsewhere. `production.test.ts` is not in this change, so it is not edited.
- Role test (`claude/roles/orchestrator_plan.test.ts`): 6 of 6 pass.
- `npx tsc --noEmit`: clean. `npx eslint` on every changed file: clean.
- Added: `execute.test.ts`: a hold that exactly fits starts; a hold that does not fit pauses before its call with the reason; a zero-estimate step at the line does not start; a zero-estimate step below the line starts; a measured hold is held to the line. `execute-categories.test.ts`: a bill above its estimate takes the copy spend past its line (recorded); a hold that would take the copy spend past its line does not start. `run.test.ts`: a later run counts a waiting job's hold (queued, no submit, no spend); a waiting hold reaches the line; a waiting job with no recorded hold refuses the run; a run at its line opens no reservation. `validate.test.ts`: an unpriced video is refused without measure and held with it; an avatar step is priced by the same ceiling. `service.test.ts`: a planning hold that does not fit is refused before any call. `policy-store.test.ts`: a row that still carries the retired key keeps its families.
- Changed to D17 (each one expected a hold above its budget to be allowed):
  1. `execute.test.ts` "a paid step starts while the spend is below the line..." (a $0.10 hold on a $0.10 line): split into a fit test at a $0.12 line and a does-not-fit test at $0.10.
  2. `execute.test.ts` "a call in flight finishes..." (the $0.10 script hold on a $0.10 line): line is now $0.15. The overshoot comes from the script's $0.50 bill.
  3. `execute.test.ts` "measure mode holds an unpriced video..." and "a measured video whose provider reports its bill..." (a $2.50 hold on a $2.00 line): line is now $3.00.
  4. `execute-categories.test.ts` "a copy line pauses the run..." (a $0.30 hold on a $0.25 line): line is now $0.50. The second step pauses on its own hold.
  5. `execute-categories.test.ts` "a step that starts below its category line may take the category past it" (a $0.90 hold on a $0.50 line): the hold is now $0.20, and the overshoot comes from a $0.90 bill.
  6. `execute-categories.test.ts` "the total still binds inside a category" (a $0.30 hold on a $0.25 total line): total line is now $0.35.
  7. `run.test.ts` "a plan whose budget is above the budget the user set..." (the analysis hold on a $0.01 line): the user's line is $0.0001, the step does not fit, and the test also checks that no request is made for it.
  8. `service.test.ts` "a planning call whose hold is above the budget starts, with a note": now refused before any call.
  9. `validate.test.ts` "the line given to the validator..." (my first draft: a $1.50 line above the $1.08 estimate, so it was not over): line is $1.00.
  Not an allowed hold, but the reason changed: `run.test.ts` "a re-run after an edit counts the money..." pauses on the D17 reason (the edited $1.20 hold does not fit $2.00 after $1.08 is committed). `approval.test.ts` passes unchanged: its $1.00 video pauses at the $0.20 line.

## Open for the lead
1. Measure mode does not reach planning or editing. `planner.ts` `planWithRole` (line 198) validates without the measure option, and `run.ts` `editStoredPlan` validates without it. An unpriced video therefore still refuses a plan at planning, so no plan can carry one yet. Threading `measure` through `planner.ts` is the fix; that file is outside this change.
2. `api.ts` `runPlanFor` (lines 95 to 152) is verified by reading only. It needs the live catalog, so no unit test reaches it.
3. D17's category reason. "Use the category name in place of 'budget'" is read as the prefix "<category> budget reached, project not finished" and "the $L <category> budget" (`execute.ts` line 97). Confirm the wording.
4. A queued step is keyed by node id (`execute.ts` line 169). After an edit, a step whose earlier job still waits reports `queued`, and its new version is not submitted until that job settles. No money is counted twice.
5. Planning validates against the plan's own budget, because `planner.ts` passes no budget. The notes stored by `service.ts` (line 202) use the user's line.
6. `orchestrator_plan@3.md` is kept. `budget/STATUS.md` line 81 cites its rule 7 by line. Delete it on the lead's word. Rule 3 of `@4`, the same rule as in `@3`, and `model_brief@1.md` line 8 still say "allowance" for a step's share; they are shipped text, so they are not edited.
7. `approval.ts` lines 1 to 3 still describe the run's "allowance". The code is unchanged, because `approval.ts` is not in the list.
8. `redoAllowanceUsd` (`run-budget.ts` line 80, `service.ts` line 133) is the contract's required field name, not a tolerance.

## Fixtures
- `openrouter-catalog-2026-10-20.json`: recorded from the four public OpenRouter listings, 2026-10-20, trimmed. Entries: 456 text, 30 video, 63 image, 36 speech.
- `sample-plan.json`: authored by hand. Not model output. Its model ids are live ids from the catalog.

## Not done
- No live call. No `OPENROUTER_API_KEY` is in the environment. Every paid step reports not_connected until a key is set, and a step with no connection holds nothing.
- No production handler yet for `edit`, `compose`, `render` (the edit and render pipeline is not wired to a plan). These report not_connected. See `docs/engine/run/DECISIONS_2026-10-22.md` D5.
- Not wired to the Factory API, the jobs queue or a screen beyond the existing orchestrator screens.
- No measure-mode toggle (a later wave). Measure mode is off by default.
- No brand-level policy override (D16 is for a later wave).
- No orchestrator model picker.
- Not connected to HyperFrames re-render.
- Not checked in a browser.

## Rating
3 of 5. The line, the D17 fit check, the queued and waiting holds and measure mode in the executor and validator are in place and tested on recorded fixtures. Planning and editing still cannot produce a plan with an unpriced step, the `api.ts` wiring has no unit test, and one base test is red.
