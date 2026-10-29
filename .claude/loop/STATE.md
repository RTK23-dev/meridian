# Loop state

The first thing a wake-up reads. Keep it short. The coding-loop skill says how each field is used.

- status: running
- branch: claude/nice-tesla-zrf6un
- pr: RTK23-dev/meridian#85 (draft, stacked on main at 0aa3301)
- started: 2026-10-29 00:09 UTC
- current_task: T3, batch 3. The next non-secret candidates are EXTERNAL_SEMANTIC_URL, EXTERNAL_SEMANTIC_MODEL, EXTERNAL_SEMANTIC_DIMENSIONS, OPENROUTER_DECISIONS_MODEL, PERCEPTION_MODEL, WHISPERX_MODEL, HIGGSFIELD_MODEL, EMAIL_API_URL, MERIDIAN_LOCAL_DATA_DIR and MERIDIAN_ARTIFACT_HOST_ALLOWLIST. Money caps (OPENROUTER_DECISION_MAX_USD_PER_CALL, CYCLONE_OBSERVATION_BUDGET) need a careful look first.
- units_done: 5 (T10, T11, T2, the acceptance fix, T12); run 5 of the gate stopped, no verdict
- next_wake_at: 2026-10-29T04:11:00Z
- wake_trigger: trig_01JNt44TWEXQLM3AYPMBc5JD
- watchdog_trigger: trig_0174D5CQELhAv3TcJVN654NM (every two hours, fires into this session)
- last_entry: RUN_LOG.md, 2026-10-29 03:55 UTC (T3 batch 2 done; ratchet 59)
- open_questions: 9 (see OPEN_QUESTIONS.md)
- permissions: `.claude/settings.json` was not written. See Q9. Until it is, use Auto mode or expect permission prompts.
- sandbox: the gate's browser step needs `GATE_ACCEPTANCE_NODE_OPTIONS` set to the Chromium path wrapper in the session scratchpad (`harness/patch-chromium.mjs`). Without it the step reports `not run: browser`.
- gate_in_progress: none. Run 5 (six groups) stopped during source group 0 with no verdict, the fourth stop. Q10 records the decision that T3 to T9 proceed on CI.
