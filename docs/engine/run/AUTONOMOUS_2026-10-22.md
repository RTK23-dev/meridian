# Autonomous run: Content Factory items 2 to 8 and what else is left (2026-10-22)

Owner instruction: finish items 2 to 8 of `docs/engine/CONTENT_FACTORY_STATE_2026-10-18.md` section 4, and whatever else is left, in one run,
without waiting for the next command. Each item is committed to `main` with its tests. Nothing here calls a live provider.

## Design decisions made on the owner's behalf in this run

- **D7 Replacement shot spec.** A remake may replace one shot's spec (its visual type, its source, or its model choice). The engine writes a new
  scene plan artifact with that shot replaced, and the remake event names it. Replay gives the same state, because the event carries the id.
  Plans keep their beats and timing; only the one shot changes.
- **D8 Edit prompt is a directed remake.** `edit_prompt` is the reviewer's text for the shot, applied as a remake direction. It is the same path
  as the direction field on the board, so the 8-direction cap and the 280-character limit apply unchanged.
- **D9 Whole-video direction is a revision.** A direction for the whole video starts a revision, whose brief carries the direction. The full
  plan is made again, as the revision path does. Re-planning only the affected shots is not built; the revision is the honest form of it.
- **D10 Mid-run remake.** A shot that is still being made can be remade: its in-flight take becomes stale (a new epoch), and the in-flight call
  is not cancelled. Its cost stays on the ledger under the reservation that paid for it, and the stale take is never counted.
- **D11 A reviewer picks a model.** The pick is checked against the live catalog for the shot's own need, priced like the orchestrator's choices,
  and carried to the take's produce job as source `reviewer`. Only generated shots have a model to choose.
- **D12 A reviewer's clip is the shot's take.** It is probed, stored, accepted with the reviewer's acceptance as its verdict, and licensed by the
  reviewer's attestation. The editor reads it as it reads any take.
- **D13 Visual, voice and video steps use the run's asset router.** The router authorizes, caches and bills each asset on the run's own
  reservation; a step's output is the stored asset's uri. A video step names its class in `params.model_class`, which the planner prompt does
  not ask for yet, so it is refused until the prompt does. Avatar, edit, compose and render stay not connected.
- **D14 Production licence source.** A take or voice track is licensed when its provider is `reviewer` or is named in
  `ENGINE_LICENSED_PROVIDERS`. The list has no default, so unset, only reviewer clips pass the rights check. The owner sets the list.

## Status (after the final pass)

Every row is on fixtures only. The final pass was written without running any test, lint or typecheck, at the owner's instruction.

| Item | State |
| --- | --- |
| 14 replacement shot spec (D7) | done, fixtures |
| 2 review inbox actions (edit prompt, change visual type; D8) | done, fixtures |
| 3 reviewer's own clip (D12) | done, fixtures; the licence source is wired (D14), with the list unset until the owner sets it |
| 4 model per remake (D11) | done, fixtures |
| 5 remake while the video is made (D10) | done, state-machine tests; the API path has no integration test |
| 6 direction for the whole video (D9) | done, fixtures |
| 7 splice render | planner done; execution NOT built: no window render and no trim/join in the repo |
| 8 variants after a remake | done, state test |
| review items 1 to 6 | done, fixtures (item 7 is an owner decision) |
| review items 8 to 11 | done, fixtures (item 9 not reproduced; no concurrency test) |
| orchestrator steps: visual, voice | done, fixtures (through the run's asset router) |
| orchestrator steps: video | done, fixtures; needs `params.model_class`, and the job is polled inside the call only |
| orchestrator steps: avatar | not connected: a presenter's voice and image are not plan inputs |
| orchestrator steps: edit, compose, render | not connected: the plan path has no edit inputs or EDL |
| re-render wiring to HyperFrames | NOT built: needs a window render |
| production licence port (rights) | done, fixtures; the list `ENGINE_LICENSED_PROVIDERS` is the owner's to set |

Known limits: every item is verified on recorded fixtures only. No live provider was called. The page has not been checked in a browser.

Checks: an earlier run of this autonomous work passed 254 tests in the API, ops, state-machine, editor and orchestrator suites, and the
Content Factory, provider and performance suites (NODE_ENV=development, as `npm test` sets it). Lint was clean on the files changed then.
The final pass changed more files and ran no test, lint or typecheck. The first run of `npm test && npm run typecheck && npm run lint` must
come before a merge.

Not finished, and why:
- Video and avatar polling: the router polls a video inside its call. A job it leaves queued has no poller, and avatar has no plan inputs.
- Edit, compose and render steps: the plan-based orchestrator is not wired to the engine's edit and render stages. Needs that wiring and a live render.
- Surgical re-render (REPLAN item 5) and the splice execution (item 7): need a window render and a media trim/join that the repository does not have.
- Review item 7 (environment-based provider status in `system-status.ts`): an owner decision. The code is unchanged.
- Owner decisions: the value of `ENGINE_LICENSED_PROVIDERS`; whether the planner prompt asks for `model_class` on video steps (a prompt version).
- Live runs (OpenRouter, Deepgram, Drive, HyperFrames, Shotstack): no keys in this environment.
