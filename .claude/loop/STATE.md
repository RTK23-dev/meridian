# Loop state

The first thing a wake-up reads. Keep it short. The coding-loop skill says how each field is used.

- status: running
- branch: claude/nice-tesla-zrf6un
- pr: RTK23-dev/meridian#85 (draft, stacked on main at 0aa3301)
- started: 2026-10-29 00:09 UTC
- current_task: T9, split of `src/engine/assets/router.ts` (1,179 lines) and `src/engine/jobs/handlers/produce-shot.ts` (1,052 lines). T4 is done in 9bb1a0b and 836b370, T5 in ba2ad93, T6 in 7ff6f76, T7 in 1354ef0, and T8 in acaf1e8. Engine API suites after T8: 608 run, 608 pass, 0 fail.
- units_done: 11 (T10, T11, T2, the acceptance fix, T12, T3 non-secret reads, T4, T5, T6, T7, T8)
- next_wake_at: 2026-10-29T06:32:00Z
- wake_trigger: trig_016G7vtYeJjYyQDAgE726sb9
- watchdog_trigger: trig_0174D5CQELhAv3TcJVN654NM (every two hours, fires into this session)
- last_entry: RUN_LOG.md, 2026-10-29 06:10 UTC (T8 pushed as acaf1e8; CI on 1354ef0, 375c695 and acaf1e8 is checked at the next wake-up)
- open_questions: 9 (see OPEN_QUESTIONS.md)
- permissions: `.claude/settings.json` was not written. See Q9. Until it is, use Auto mode or expect permission prompts.
- sandbox: the gate's browser step needs `GATE_ACCEPTANCE_NODE_OPTIONS` set to the Chromium path wrapper in the session scratchpad (`harness/patch-chromium.mjs`). Without it the step reports `not run: browser`.
- gate_in_progress: none. Run 5 (six groups) stopped during source group 0 with no verdict, the fourth stop. Q10 records the decision that T3 to T9 proceed on CI.
