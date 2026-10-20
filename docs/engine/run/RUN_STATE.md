# Run state

Single loop, lead only, no subagents (owner, 2026-10-20). Branch `run/factory-6h`, built from `main`. Work is pushed between blocks.
Governing plan: `REPLAN_2026-10-20.md`.

## Log

- 2026-10-20 22:36Z. Preflight: Claude Code 2.1.304. `CLAUDE_CODE_EFFORT_LEVEL` and `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` not set. No `OPENROUTER_API_KEY` in the environment. OpenRouter public listings reachable (200).
- 2026-10-20 22:36Z. Recorded the live catalog snapshot (585 entries).
- 2026-10-20 22:40Z. Merged `claude/nice-tesla-zrf6un` into `run/factory-6h`. No conflicts. Gates on the merge: `npm test` 5617 tests (5576 pass, 0 fail, 41 skipped) before the orchestrator commit; typecheck exit 0; lint 0 errors.
- 2026-10-20 22:41Z. Orchestrator core written: contracts, catalog, validate, dirty, execute, layout, replay, canvas component. Orchestrator tests 52 of 52 pass; typecheck exit 0; lint exit 0 on new files.
- Full `npm test` on the merged tree with the orchestrator: pending (see the next entry).

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
