# Loop state

The first thing a wake-up reads. Keep it short. The coding-loop skill says how each field is used.

- status: running
- branch: claude/nice-tesla-zrf6un
- pr: RTK23-dev/meridian#85 (draft, stacked on main at 0aa3301)
- started: 2026-10-29 00:09 UTC
- current_task: T1 (verdict pending). T12 is done (3828402). The gate now runs the source tests in CI's six groups (Q10). Run 5 started at 02:29 UTC (gate-run5.log). After T1, T3 to T9 are unblocked.
- units_done: 5 (T10 4f9e986, T11 268bc27, T2 b00266c, acceptance fix a220bf4, T12 3828402)
- next_wake_at: 2026-10-29T02:55:00Z
- wake_trigger: trig_01FoAh9PDj1MYwoki8zJVct3
- watchdog_trigger: trig_0174D5CQELhAv3TcJVN654NM (every two hours, fires into this session)
- last_entry: RUN_LOG.md, 2026-10-29 02:45 UTC (T12 done; gate changed to six groups, run 5 started)
- open_questions: 9 (see OPEN_QUESTIONS.md)
- permissions: `.claude/settings.json` was not written. See Q9. Until it is, use Auto mode or expect permission prompts.
- sandbox: the gate's browser step needs `GATE_ACCEPTANCE_NODE_OPTIONS` set to the Chromium path wrapper in the session scratchpad (`harness/patch-chromium.mjs`). Without it the step reports `not run: browser`.
- gate_in_progress: started 2026-10-29 02:29 UTC (process `node scripts/gate.mjs`, log `gate-run5.log` in the scratchpad, six source groups). If the wake-up finds it still running, do not start a second gate, and re-arm for 15 minutes. If the log has `gate: result`, record it in RUN_LOG.md, and if the verdict is PASS, mark T1 done. If the log has `stopped by` or the process is gone with no verdict, record the step in RUN_LOG.md as a blocker and use the green CI on the head as the interim evidence.
