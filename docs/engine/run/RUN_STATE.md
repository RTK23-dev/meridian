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
- Still fixed: the three Claude role models (`llm.direction`, `llm.analysis`, `llm.check`) and the Deepgram `nova-3` model in the stt route. The Claude roles are the production LLM path; changing them needs the owner's cutover decision.

## Current state

| Area | State |
|---|---|
| Orchestrator core (plan, validate, surgical edits, executor, layout, replay) | Built and tested with fixtures |
| Live catalog | Recorded 2026-10-20; the runtime reads it through the gateway |
| Fixed model ids in the legacy pipeline (`routes.ts`, `prices.ts`) | Still present; the orchestrator does not use them |
| Canvas on a screen | Component built; not mounted |
| Live runs | Not run: no key in the environment |
| Browser check | Not done |

## Blocked on the owner

- An OpenRouter key in the environment, with a hard credit limit set on the OpenRouter side. That is the only way the live steps can run.
- Open decisions in the Bible 20.2 list, and the storage, Veo and Hypit conflicts in `CLAUDE.md`.
