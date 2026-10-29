# Loop state

The first thing a wake-up reads. Keep it short. The coding-loop skill says how each field is used.

- status: running
- branch: claude/nice-tesla-zrf6un
- pr: RTK23-dev/meridian#85 (draft, stacked on main at 0aa3301)
- started: 2026-10-29 00:09 UTC
- current_task: T3 (typed configuration for non-secret settings). T1 stays open; see Q10 for the decision that lets T3 to T9 start on CI.
- units_done: 5 (T10, T11, T2, the acceptance fix, T12); run 5 of the gate stopped, no verdict
- next_wake_at: 2026-10-29T03:17:00Z
- wake_trigger: trig_01WRHpAVC9WRHyLtrqhBNLJZ
- watchdog_trigger: trig_0174D5CQELhAv3TcJVN654NM (every two hours, fires into this session)
- last_entry: RUN_LOG.md, 2026-10-29 02:57 UTC (run 5 stopped; Q10 decision; T3 next)
- open_questions: 9 (see OPEN_QUESTIONS.md)
- permissions: `.claude/settings.json` was not written. See Q9. Until it is, use Auto mode or expect permission prompts.
- sandbox: the gate's browser step needs `GATE_ACCEPTANCE_NODE_OPTIONS` set to the Chromium path wrapper in the session scratchpad (`harness/patch-chromium.mjs`). Without it the step reports `not run: browser`.
- gate_in_progress: none. Run 5 (six groups) stopped during source group 0 with no verdict, the fourth stop. Q10 records the decision that T3 to T9 proceed on CI.
