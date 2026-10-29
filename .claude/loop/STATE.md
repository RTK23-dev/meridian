# Loop state

The first thing a wake-up reads. Keep it short. The coding-loop skill says how each field is used.

- status: running
- branch: claude/nice-tesla-zrf6un
- pr: RTK23-dev/meridian#85 (draft, stacked on main at 0aa3301)
- started: 2026-10-29 00:09 UTC
- current_task: T5, split of `src/lib/meridian/factory/worker.ts` (1,070 lines). T4 is done in 9bb1a0b and 836b370. Studio suites after T4: 238 run, 228 pass, 0 fail, 10 skipped.
- units_done: 7 (T10, T11, T2, the acceptance fix, T12, T3 non-secret reads, T4)
- next_wake_at: 2026-10-29T06:00:00Z
- wake_trigger: trig_01UUXHovuLik9EkhypJbjg85
- watchdog_trigger: trig_0174D5CQELhAv3TcJVN654NM (every two hours, fires into this session)
- last_entry: RUN_LOG.md, 2026-10-29 05:39 UTC (T4 batch 2 pushed as 836b370; CI on that head is checked at the next wake-up)
- open_questions: 9 (see OPEN_QUESTIONS.md)
- permissions: `.claude/settings.json` was not written. See Q9. Until it is, use Auto mode or expect permission prompts.
- sandbox: the gate's browser step needs `GATE_ACCEPTANCE_NODE_OPTIONS` set to the Chromium path wrapper in the session scratchpad (`harness/patch-chromium.mjs`). Without it the step reports `not run: browser`.
- gate_in_progress: none. Run 5 (six groups) stopped during source group 0 with no verdict, the fourth stop. Q10 records the decision that T3 to T9 proceed on CI.
