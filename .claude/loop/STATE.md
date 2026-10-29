# Loop state

The first thing a wake-up reads. Keep it short. The coding-loop skill says how each field is used.

- status: running
- branch: claude/nice-tesla-zrf6un
- pr: RTK23-dev/meridian#85 (draft, stacked on main at 0aa3301)
- started: 2026-10-29 00:09 UTC
- current_task: T14, handoff: update `docs/STATE_2026-10-28.md` section 10 with the new numbers, update `docs/FIRST_TEST_RUN.md` with the owner's checklist for the live steps, and run the gate once on the final commit and record it. T13 is done: the release acceptance gave 25 of 25 locally. T9 is done in 6730129 and baa3a64, and T4 to T8 in 9bb1a0b, 836b370, ba2ad93, 7ff6f76, 1354ef0 and acaf1e8.
- units_done: 14 (T10, T11, T2, the acceptance fix, T12, T3 non-secret reads, T4, T5, T6, T7, T8, T9a, T9b, T13)
- next_wake_at: 2026-10-29T07:16:00Z
- wake_trigger: trig_01BsYDhUqhKXPiASoeyVSgku
- watchdog_trigger: trig_0174D5CQELhAv3TcJVN654NM (every two hours, fires into this session)
- last_entry: RUN_LOG.md, 2026-10-29 06:55 UTC (CI green on the T9 to T13 heads; the T14 gate is at source group 4, and its totals are read at the next wake-up)
- open_questions: 10 (see OPEN_QUESTIONS.md; Q13 is decided by the loop and asks for confirmation)
- permissions: `.claude/settings.json` was not written. See Q9. Until it is, use Auto mode or expect permission prompts.
- sandbox: the gate's browser step needs `GATE_ACCEPTANCE_NODE_OPTIONS` set to the Chromium path wrapper in the session scratchpad (`harness/patch-chromium.mjs`). Without it the step reports `not run: browser`.
- gate_in_progress: none. Run 5 (six groups) stopped during source group 0 with no verdict, the fourth stop. Q10 records the decision that T3 to T9 proceed on CI.
