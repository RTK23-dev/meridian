# Run state

Single loop, lead only, no subagents (owner, 2026-10-20). Branch `run/factory-6h`, built from `main`. Work is pushed between blocks.
Governing plan: `REPLAN_2026-10-20.md`.

## Log

- 2026-10-20 22:36Z. Preflight: Claude Code 2.1.304. `CLAUDE_CODE_EFFORT_LEVEL` and `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` not set. No `OPENROUTER_API_KEY` in the environment. OpenRouter public listings reachable (200).
- 2026-10-20 22:36Z. Recorded the live catalog snapshot (585 entries).
- 2026-10-20 22:40Z. Merged `claude/nice-tesla-zrf6un` into `run/factory-6h`. No conflicts. Gates on the merge: `npm test` 5617 tests (5576 pass, 0 fail, 41 skipped) before the orchestrator commit; typecheck exit 0; lint 0 errors.
- 2026-10-20 22:41Z. Orchestrator core written: contracts, catalog, validate, dirty, execute, layout, replay, canvas component. Orchestrator tests 52 of 52 pass; typecheck exit 0; lint exit 0 on new files.
- 2026-10-20 23:1xZ. Full `npm test` on the merged tree with the orchestrator: exit 0. Main suite 5700 tests (5659 pass, 0 fail, 41 skipped, env-gated). Script tests 160 pass. Typecheck exit 0. Lint 0 errors, 4 pre-existing warnings.
- Committed `e514b53` and pushed `run/factory-6h` to origin (new branch).
- 2026-10-20 23:0xZ. Pushed `cf60a33` (run state).
- 2026-10-20 23:2xZ. Planner added (`planner.ts`): asks the orchestrating model for a plan, treats the reply as untrusted, validates it against the live catalog; no plan on any failure. Recorded example run added (`example.ts`, stored as `fixtures/example-events.ts`, checked by test). Screen and route added: `/orchestrator` (recorded example, no provider called).
- Browser check of `/orchestrator` on the dev server (auth off, dev user): no console errors; no horizontal overflow at 390px; screenshots in the session scratchpad.
- Attempted: remove the fixed media fallback ids from `routes.ts` (Kling, Veo lite, Seedream 4.5, ElevenLabs v4, Gemini TTS). Reverted: 35 tests assert those fallbacks through adapters, so the change needs the adapters to take the live choice explicitly. That is the next block, not a one-line edit.
- 2026-10-20 23:5xZ. Pushed `bf7854e` (planner, recorded example, `/orchestrator`). Full suite on that tree: 5711 tests, 5670 pass, 0 fail, 41 skipped, exit 0. Lint exit 0 (0 errors, 4 pre-existing warnings). Typecheck exit 0.
- Status page published (private, no wake subscription registered): https://claude.ai/artifact/1szjYSNUowxC2ozQkK7ygD
- 2026-10-21. Removed the fixed media model ids from `routes.ts`: Kling (`video.cinematic`), Veo 3.1 Lite (`video.budget`), Seedream 4.5 (`image.keyframe`), ElevenLabs v4 and Gemini TTS (`tts`). What makes this safe: `gateway.chosen(capability, modelId)` routes a live-catalog choice; the video profile loader reads every model the live listing names instead of the table's; the chooser's fallback is the first eligible catalog candidate instead of the table's model; a chooser with no candidate leaves the call out (`no model for <class>`). Tests moved to explicit live ids or to a test table that names them. Affected set: 282 of 282 pass. Full suite: see the next entry.
- 2026-10-21. The orchestrator prices plans from the live catalog, not from the plan. The catalog snapshot now carries prices (text per token, image per image, video per second at 1080p). `validatePlan` computes each paid step's cost from its model's price and returns the checked plan; the plan's own `estimateUsd` is overwritten. A step with no price basis for its model (no per-image price, no per-second price, missing seconds or characters) does not run.
- 2026-10-21. The planner's live path is blocked by a migration and a contract change, written up for the owner in `docs/engine/run/PROPOSED_MIGRATION_ORCHESTRATOR_ROLE.md`: the role names are enforced by CHECK constraints in migrations 0081 and 0100.
- 2026-10-21. Offline plan editor on `/orchestrator`: pick a paid step, change its seconds, characters, output tokens or model from the recorded catalog. The page shows the engine's new cost, the steps that would run again (drawn dashed and labelled "To re-run"), or the refusal reasons. Browser-checked: 8 s gives $1.6846 and four steps to re-run; 90 s is clamped to 60 s and refused over budget; no console errors. The canvas draws the whole plan while an edit is open.
- Known limit: the canvas is wider than the screen, so the stale steps can be off to the right and need a scroll. Not fixed yet.
- Still fixed: the three Claude role models (`llm.direction`, `llm.analysis`, `llm.check`) and the Deepgram `nova-3` model in the stt route. The Claude roles are the production LLM path; changing them needs the owner's cutover decision (where the user's orchestrator choice is stored).

## Current state

| Area | State |
|---|---|
| Orchestrator core (plan, validate, surgical edits, executor, layout, replay) | Built and tested with fixtures |
| Live catalog | Recorded 2026-10-20; the runtime reads it through the gateway |
| Fixed model ids in the legacy pipeline (`routes.ts`) | Media ids removed; the three Claude roles and the Deepgram model id remain |
| Canvas on a screen | Component built; not mounted |
| Live runs | Not run: no key in the environment |
| Browser check | Not done |

## Blocked on the owner

- An OpenRouter key in the environment, with a hard credit limit set on the OpenRouter side. That is the only way the live steps can run.
- Open decisions in the Bible 20.2 list, and the storage, Veo and Hypit conflicts in `CLAUDE.md`.

## Pushed head a2a0dc1 (2026-10-21)

- Full suite on the pushed tree: 5716 tests, 5675 pass, 0 fail, 41 skipped (environment-gated), exit 0. Typecheck exit 0. Lint 0 errors.
- Status page (private, version 2): https://claude.ai/artifact/1szjYSNUowxC2ozQkK7ygD
- Still open, in order: (1) the owner's OpenRouter key in the environment, then recorded live calls with ledger and OpenRouter usage matched; (2) approval of the orchestrator role contract and migration (`PROPOSED_MIGRATION_ORCHESTRATOR_ROLE.md`); (3) the Claude role models and the Deepgram id out of the route table, after the cutover decision; (4) a plan store and Factory API route; (5) surgical re-render through the compose and render steps; (6) canvas fit-to-width so stale steps are on screen without scrolling.
