# Loop state

The first thing a wake-up reads. Keep it short. The coding-loop skill says how each field is used.

- status: running (round 3: cookbook presets, K0 to K30, then the owner-decision backlog B1 to B16; see RUN_PLAN.md)
- branch: claude/nice-tesla-zrf6un
- pr: RTK23-dev/meridian#85 (draft, stacked on main at 0aa3301). Q44 is open: a new PR for the new work needs a new branch.
- started: 2026-10-29 00:09 UTC
- next_task: B1, delete `src/engine/orchestrator/example.ts` and its test (Q43), then B2 to B16 in order (RUN_PLAN.md, "Backlog from the owner's decisions").
- current_task: none. The owner's chat decisions of 2026-11-01 are recorded in OPEN_QUESTIONS.md and RUN_PLAN.md.
- open_questions: 3 open, one of the three most important each: Q34 (the selector role, a contract change; blocks K10's live port), Q39 (the 3D explainer's scenes; blocks K23, K24, K29, K30) and Q44 (the pull request; blocks R8). All other questions are answered.
- units_done: round 1: 14 (T1 closed on CI's verdict, Q10). Round 2: R1, R2, R3 (browser check pending), R4, R7; R5 active until the module backlog units are done. Round 3: K0 to K9, K11, K12, K14, K18, K19, K19b, K20 (except K20f, parked until K29), K21, K22 (Q38), K25 (Q40 b), K26, K27. Partly done: K10 (live port, Q34), K13, K15, K16, K17, K28 (pending on B11). K30: guide written, PR refresh pending.
- owner_requests_done: the preset preview (two original renders, preset version 2, the nan loudness fix) and the cookbook plan (round 3 in RUN_PLAN.md, Q31). Done 20:30 UTC.
- next_wake_at: 2026-11-01T16:57:00Z
- wake_trigger: trig_01C21ayNP4FrjbgEGvQWJteL (armed 16:36 UTC, 20 minutes after the decisions were recorded; the wake trig_01XqJxdHya82SpH4fWb5WyyN was replaced by it)
- watchdog_trigger: trig_013BHUFk1JYN8Lkt1nFRh3Fd (every two hours, fires into this session)
- last_entry: RUN_LOG.md, the 16:36 UTC entry (owner decisions recorded, backlog set)
- permissions: `.claude/settings.json` is written (round 2, Q9): full coding permissions, with the hard stops denied.
- sandbox: the browser step of the gate needs `GATE_ACCEPTANCE_NODE_OPTIONS` pointing at a Chromium wrapper. The session scratchpad that held it is gone; the wrapper must be recreated if the gate is run again.
- gate_in_progress: none.
