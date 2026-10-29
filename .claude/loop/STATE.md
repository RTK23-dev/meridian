# Loop state

The first thing a wake-up reads. Keep it short. The coding-loop skill says how each field is used.

- status: running
- branch: claude/nice-tesla-zrf6un
- pr: RTK23-dev/meridian#85 (draft, stacked on main at 0aa3301)
- started: 2026-10-29 00:09 UTC
- current_task: T1 (active). The full gate is running in the background; its log is `/tmp/claude-0/-home-user-meridian/c8103ffb-c1a2-5f2b-9e50-b96a956b5eed/scratchpad/gate-run1.log`, and each step's output is in `artifacts/gate/`.
- units_done: 0
- next_wake_at: 2026-10-29T01:12:00Z
- wake_trigger: trig_01WmBU1T4yuNMPTovEauzBgs
- watchdog_trigger: trig_0174D5CQELhAv3TcJVN654NM (every two hours, fires into this session)
- last_entry: RUN_LOG.md, 2026-10-29 00:56 UTC (gate stopped twice without a verdict; now writes per-step progress)
- open_questions: 9 (see OPEN_QUESTIONS.md)
- permissions: `.claude/settings.json` was not written. See Q9. Until it is, use Auto mode or expect permission prompts.
- sandbox: the gate's browser step needs `GATE_ACCEPTANCE_NODE_OPTIONS` set to the Chromium path wrapper in the session scratchpad (`harness/patch-chromium.mjs`). Without it the step reports `not run: browser`.
- gate_in_progress: restarted 2026-10-29 00:55 UTC (process `node scripts/gate.mjs`, log `gate-run4.log` in the scratchpad). The gate now writes each finished step to artifacts/gate/ and records any SIGHUP, SIGINT or SIGTERM, because the two earlier runs (gate-run2 and gate-run3) stopped without a verdict during the source tests. If the wake-up finds it still running, do not start a second gate, and re-arm for 15 minutes. If the log holds a verdict line (`gate: result`), record it in RUN_LOG.md. If the log says `stopped by` or the process is gone with no verdict, record that as a blocker and use the green CI on the head as the interim evidence.
