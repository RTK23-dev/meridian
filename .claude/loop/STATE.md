# Loop state

The first thing a wake-up reads. Keep it short. The coding-loop skill says how each field is used.

- status: running
- branch: claude/nice-tesla-zrf6un
- pr: RTK23-dev/meridian#85 (draft, stacked on main at 0aa3301)
- started: 2026-10-29 00:09 UTC
- current_task: T11 (pending, unblocked by T10). T1 is active with its verdict blocked; see Q10.
- units_done: 1 (T10, the preset proposal, 4f9e986)
- next_wake_at: 2026-10-29T01:36:00Z
- wake_trigger: trig_018kSFsMBtGBFogE3GWFwDu7
- watchdog_trigger: trig_0174D5CQELhAv3TcJVN654NM (every two hours, fires into this session)
- last_entry: RUN_LOG.md, 2026-10-29 01:20 UTC (T10 done; T1 blocked on the local source step)
- open_questions: 9 (see OPEN_QUESTIONS.md)
- permissions: `.claude/settings.json` was not written. See Q9. Until it is, use Auto mode or expect permission prompts.
- sandbox: the gate's browser step needs `GATE_ACCEPTANCE_NODE_OPTIONS` set to the Chromium path wrapper in the session scratchpad (`harness/patch-chromium.mjs`). Without it the step reports `not run: browser`.
- gate_in_progress: none. The gate-run4 process stopped during the source tests with no verdict (third time). See Q10 for the decision to run the source tests in CI's six groups. The steps that finished are in artifacts/gate/.
