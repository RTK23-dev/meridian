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
- Tests: 139 across this folder, all passing (`node --test src/engine/orchestrator/*.test.ts`). `no-fixed-models.test.ts` fails if any source file here names a model id.

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
