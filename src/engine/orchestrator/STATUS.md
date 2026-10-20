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
- Tests: 52, all passing. `no-fixed-models.test.ts` fails if any source file here names a model id.

## Fixtures
- `openrouter-catalog-2026-10-20.json`: recorded from the four public OpenRouter listings, 2026-10-20, trimmed. Entries: 456 text, 30 video, 63 image, 36 speech.
- `sample-plan.json`: authored by hand. Not model output. Its model ids are live ids from the catalog.

## Not done
- No live call. No `OPENROUTER_API_KEY` is in the environment.
- Not wired to the Factory API, the jobs queue or a screen.
- No orchestrator model picker.
- Not connected to HyperFrames re-render.
- Not checked in a browser.
