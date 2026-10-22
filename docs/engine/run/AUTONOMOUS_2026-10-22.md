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

(Further decisions are appended below as they are made.)

## Status (updated as the run goes)

| Item | State | Commits on main |
| --- | --- | --- |
| 14 replacement shot spec (D7) | done, fixtures | replacement commit |
| 2 review inbox actions (edit prompt, change visual type; D8) | done, fixtures; board controls with item 4 | review inbox commit, items 2 and 4 commit |
| 3 reviewer's own clip (D12) | done, fixtures; the production licence port is not wired (see below) | item 3 commit |
| 4 model per remake (D11) | done, fixtures | items 2 and 4 commit |
| 5 remake while the video is made (D10) | done, state-machine tests; the API path has no integration test | item 5 commit, lint fix |
| 6 direction for the whole video (D9) | done, fixtures | item 6 commit |
| 7 splice render | planner done; execution NOT built: no window render and no trim/join in the repo | splice planner commit |
| 8 variants after a remake | done, state test | item 8 commit |
| review items 1 to 4 (paid retry, plan hold, text bound, plan release) | done | review items 1 to 4 commit |
| review item 5 (status vs metric jobs) | done for the status and the metric schedule | review item 5 commit |
| review item 6 (token expiry) | status side done; the job-side checks are NOT done | review item 6 commit |
| orchestrator steps: visual and voice through the run's asset router (D13) | done, fixtures | visual and voice commit |
| orchestrator steps: video and avatar (queued jobs; the orchestrator does not poll them yet) | open | |
| orchestrator steps: edit, compose and render (the engine's edit and render pipeline is not wired to a plan) | open | |
| remaining: re-render wiring to HyperFrames | open (needs a window render) | |
| remaining: review items 7 to 11 | open (7 owner decision; 8 latent; 9 needs concurrency; 10 no caller; 11 small copy) | |
| remaining: production licence port (rights) | open: an owner decision on which sources are licensed | |

Known limits: every item is verified on recorded fixtures only. No live provider was called. The page has not been checked in a browser.

Final state of this run: 254 tests in the API, ops, state-machine, editor and orchestrator suites pass, plus the Content Factory, provider and
performance suites (run with NODE_ENV=development, as `npm test` does). Lint is clean on every file changed in this run. Typecheck was not
run, as the owner asked for this run; the new TypeScript is unverified by the compiler.

Not finished, and why:
- Video and avatar steps: they are queued jobs; the orchestrator has no poller for them. Needs the poller and a persisted running state.
- Edit, compose and render steps: the plan-based orchestrator is not wired to the engine's edit and render stages. Needs that wiring and a live render.
- Surgical re-render (REPLAN item 5) and the splice execution (item 7): need a window render and a media trim/join that the repository does not have.
- Production licence port (the rights gate): an owner decision on which sources are licensed. Without it the pre-render gate cannot evaluate rights for any video.
- Job-side token expiry checks (review item 6): the status refuses an expired token; the jobs that read the token do not yet.
- Review items 7 to 11: 7 is an owner decision (environment-based provider status); 8 is latent; 9 needs concurrent calls to reproduce; 10 has no caller; 11 is small copy.
- Live runs (OpenRouter, Deepgram, Drive, HyperFrames, Shotstack): no keys in this environment.
