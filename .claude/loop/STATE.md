# Loop state

The first thing a wake-up reads. Keep it short. The coding-loop skill says how each field is used.

- status: running
- branch: claude/nice-tesla-zrf6un
- pr: RTK23-dev/meridian#85 (draft, stacked on main at 0aa3301)
- started: 2026-10-29 00:09 UTC
- current_task: T3, batch 4 (the rest of the non-secret reads). The two money caps (OPENROUTER_DECISION_MAX_USD_PER_CALL, CYCLONE_OBSERVATION_BUDGET) need a careful look before they move. Secrets stay with the resolver.
- units_done: 5 (T10, T11, T2, the acceptance fix, T12); run 5 of the gate stopped, no verdict
- next_wake_at: 2026-10-29T04:42:00Z
- wake_trigger: trig_016LodY576UPTyWZCMd6pHYt
- watchdog_trigger: trig_0174D5CQELhAv3TcJVN654NM (every two hours, fires into this session)
- last_entry: RUN_LOG.md, 2026-10-29 04:17 UTC (T3 batch 3 done; ratchet 44)
- open_questions: 9 (see OPEN_QUESTIONS.md)
- permissions: `.claude/settings.json` was not written. See Q9. Until it is, use Auto mode or expect permission prompts.
- sandbox: the gate's browser step needs `GATE_ACCEPTANCE_NODE_OPTIONS` set to the Chromium path wrapper in the session scratchpad (`harness/patch-chromium.mjs`). Without it the step reports `not run: browser`.
- gate_in_progress: none. Run 5 (six groups) stopped during source group 0 with no verdict, the fourth stop. Q10 records the decision that T3 to T9 proceed on CI.
