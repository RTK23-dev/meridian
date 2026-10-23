# Orchestrator: status

Owner direction, 2026-10-20: the orchestrating model is chosen by the user from the live OpenRouter catalog; no model is fixed in code.

## Done
- `contracts.ts`: plan (`orchestrator-plan@1`), ten step kinds, live model reference, step events. Strict zod v4.
- `catalog.ts`: parses a live snapshot; drops bad rows with reasons; refuses a snapshot with no list.
- `validate.ts`: fail-closed plan validation. Every reason is returned.
- `dirty.ts`: surgical edits. Stale set, and cache keys that ignore title and wording.
- `execute.ts`: executor with injected handlers. `not_connected`, `failed`, `skipped`, `paused` (budget) and `cache_hit` are all reported as they are.
- `layout.ts`, `replay.ts`: canvas geometry and replay.
- Canvas component: `src/components/content-factory/orchestrator-canvas.tsx`.
- `run-budget.ts`: a run takes one reservation for what the plan may still spend, under an `orchestrator_run` request row. Refused when nothing is left, when the workspace month cannot cover it, or when the reservation does not match its contract. Released when the run stops.
- `categories.ts` (owner direction 2026-10-23, D3): the copy, creative and voice budgets. Copy is analysis and script, creative visual, video and avatar, voice voice. `envelope.ts` gives each set category an envelope; `validate.ts` reports each one's position; `execute.ts` pauses before a step that would pass its category's allowance, and `store.ts` keeps each stored output's category. A failed step's hold takes its step's category. The planning call is not in any category.
- `production.ts`: handlers for `reference` (text or a brand; no model call) and `analysis` and `script` (a paid text call on the model the plan chose, authorized and billed on the run's reservation; a missing connection stops before any hold; a repeated call is refused, not paid again; a missing upstream body fails closed).
- Migration `0110`: `orchestrator_step_outputs.body`, so a downstream step reads content, not its hash.
- Tests: 231 across this folder, all passing (`node --test src/engine/orchestrator/*.test.ts`). `no-fixed-models.test.ts` fails if any source file here names a model id.

## Queued holds (owner direction 2026-10-23, D14 and D15; migration 0117)
- Migration `0117`: `orchestrator_asset_jobs` gets `held_usd` (the row's hold in total), `hold_usd` (one submit's hold) and `seconds`, all nullable and not negative. New table `orchestrator_cost_measurements`: one reported bill per plan and cache key, with the clip's length.
- `holds.ts`: `waitingHoldsByNode` sums a plan's waiting holds by step and lists a waiting row with no recorded hold as `unrecorded` (never zero). `openQueuedJob` is true while a plan has a waiting job for a cache key. `recordCostMeasurement` writes one measurement per plan and cache key. `measuredAverageUsdPerSecond` is the reported bills over the lengths, or null. Every query is scoped to the organization.
- `production.ts`: a video or avatar step with a job still waiting for its key reports queued and submits nothing (needs `sql`). A step with no hold is refused before any submit: its engine estimate, or in measure mode (`measure`) its ceiling times its length. A queued job carries its hold and its length.
- `asset-poll.ts`: a finished job is stored at its reported bill and measured when its length is known; with no reported bill it is stored at its hold, never null. A failed or unsettled job, or a poll that threw on a row with a hold, closes as failed and its hold is charged as a failed event. A retry the router submits adds its hold to the row's total. A job still working keeps its hold. Each change of money is one transaction.
- Tests: `asset-poll.test.ts` (20: ten on recorded answers, ten on the database), `holds.test.ts` (6, on the database), `production.test.ts` (26; five are new, three of them on the database). Typecheck and eslint on the changed files are clean.

### Open for the lead (not in this change)
- Measure mode cannot run yet. `validate.ts` `priceStep` (line 91) refuses a video or avatar with no per-second listing price, and `execute.ts` (line 148) fails a paid step with a null estimate before its handler runs. Both must let a measured step through, and the allowance check must use its hold, not its estimate.
- `execute.ts` (lines 210-212) charges a queued step's estimate to this run's spend. A re-run's guarded step is already in the waiting holds, so once `run.ts` adds those holds to the spend, that step counts twice in the run. A new submit's hold should count once; a guarded re-run should add nothing.
- Wiring: `api.ts` passes `sql` and `measure` to `productionHandlers`; `run.ts` adds `waitingHoldsByNode` to the spend and refuses a run with `unrecorded` steps.
- Router accounting (`assets/router.ts`). A settle that falls back to another target starts that target's bill at zero (line 624), so the stored output and the measurement cover only the winning target's bills. A failed attempt the router makes inside one submit call is not one of the row's holds. The run's reservation still caps the ledger; the plan's spend view can be lower. `job.submitNumber` counts every authorized submit, so `hold_usd × submitNumber` would give the row's total without either gap.
- Owner decisions: (a) a poll that throws closes a row that has a hold, as the spec says. The provider job may still finish, and the ledger key stays unsettled, so a re-run answers unsettled until an operator settles it. Keeping such a row open, with its hold still counted, is the alternative. (b) A row queued before 0117 has no recorded hold. While the provider has not answered, a thrown poll leaves it open and its run refuses. A definitive answer without a bill closes it with no event, so its unknown bill is not counted.

## Fixtures
- `openrouter-catalog-2026-10-20.json`: recorded from the four public OpenRouter listings, 2026-10-20, trimmed. Entries: 456 text, 30 video, 63 image, 36 speech.
- `sample-plan.json`: authored by hand. Not model output. Its model ids are live ids from the catalog.

## Not done
- No live call. No `OPENROUTER_API_KEY` is in the environment. Every paid step reports not_connected until a key is set, and a step with no connection holds nothing.
- No production handler yet for `visual`, `voice`, `video`, `avatar` (their adapters are not wired to a step) or `edit`, `compose`, `render` (the edit and render pipeline is not wired to a plan). These report not_connected. See `docs/engine/run/DECISIONS_2026-10-22.md` D5.
- Not wired to the Factory API, the jobs queue or a screen.
- No orchestrator model picker.
- Not connected to HyperFrames re-render.
- Not checked in a browser.
