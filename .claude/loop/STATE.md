# Loop state

The first thing a wake-up reads. Keep it short. The coding-loop skill says how each field is used.

- status: running
- branch: claude/nice-tesla-zrf6un
- pr: RTK23-dev/meridian#85 (draft, stacked on main at 0aa3301)
- started: 2026-10-29 00:09 UTC
- current_task: T12 (hook timing rules, depends on T2, now unblocked). T3 and T4 onward depend on T1, whose local verdict is blocked; see Q10.
- units_done: 3 (T10 at 4f9e986, T11 at 268bc27, T2 in the next commit)
- next_wake_at: 2026-10-29T02:23:00Z
- wake_trigger: trig_01PqSVkTtfrYUbx3A493KS1n
- watchdog_trigger: trig_0174D5CQELhAv3TcJVN654NM (every two hours, fires into this session)
- last_entry: RUN_LOG.md, 2026-10-29 02:03 UTC (T2 done: short-form research note)
- open_questions: 9 (see OPEN_QUESTIONS.md)
- permissions: `.claude/settings.json` was not written. See Q9. Until it is, use Auto mode or expect permission prompts.
- sandbox: the gate's browser step needs `GATE_ACCEPTANCE_NODE_OPTIONS` set to the Chromium path wrapper in the session scratchpad (`harness/patch-chromium.mjs`). Without it the step reports `not run: browser`.
- gate_in_progress: none. The gate-run4 process stopped during the source tests with no verdict (third time). See Q10 for the decision to run the source tests in CI's six groups. The steps that finished are in artifacts/gate/.
