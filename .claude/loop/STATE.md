# Loop state

The first thing a wake-up reads. Keep it short. The coding-loop skill says how each field is used.

- status: running
- branch: claude/nice-tesla-zrf6un
- pr: RTK23-dev/meridian#85 (draft, stacked on main at 0aa3301)
- started: 2026-10-29 00:09 UTC
- current_task: T6, split of `src/lib/meridian/content-factory/service.ts` (1,097 lines). T4 is done in 9bb1a0b and 836b370, and T5 in ba2ad93. Factory suites after T5: 407 run, 407 pass, 0 fail.
- units_done: 8 (T10, T11, T2, the acceptance fix, T12, T3 non-secret reads, T4, T5)
- next_wake_at: 2026-10-29T06:08:00Z
- wake_trigger: trig_01PjbgefPCt4H6jaAUGCU3xj
- watchdog_trigger: trig_0174D5CQELhAv3TcJVN654NM (every two hours, fires into this session)
- last_entry: RUN_LOG.md, 2026-10-29 05:47 UTC (T5 pushed as ba2ad93; CI on aa858c2 and ba2ad93 is checked at the next wake-up)
- open_questions: 9 (see OPEN_QUESTIONS.md)
- permissions: `.claude/settings.json` was not written. See Q9. Until it is, use Auto mode or expect permission prompts.
- sandbox: the gate's browser step needs `GATE_ACCEPTANCE_NODE_OPTIONS` set to the Chromium path wrapper in the session scratchpad (`harness/patch-chromium.mjs`). Without it the step reports `not run: browser`.
- gate_in_progress: none. Run 5 (six groups) stopped during source group 0 with no verdict, the fourth stop. Q10 records the decision that T3 to T9 proceed on CI.
