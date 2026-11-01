# Loop state

The first thing a wake-up reads. Keep it short. The coding-loop skill says how each field is used.

- status: running, final version in progress on branch claude/cookbook-presets-zrf6un (new draft PR for rounds 2 and 3, Q44 b). Nothing pushed yet: one push, after the verification in RUN_PLAN, "Final version".
- branch: claude/cookbook-presets-zrf6un (created 2026-11-01 from 09a8423; claude/nice-tesla-zrf6un and PR #85 are left as they are)
- pr: RTK23-dev/meridian#85 (draft, stacked on main at 0aa3301). Q44 is open: a new PR for the new work needs a new branch.
- started: 2026-10-29 00:09 UTC
- next_task: B11 (Q41, K28): the per-output measures migration (0144, since 0143 is cookbook_selector), then the export file. Then B12 to B16, K13, K15, K16, K17, K23 and K24 (Q39 recommendation), K29, K20f, K30, and the verification in RUN_PLAN, "Final version".
- current_task: none. The owner's chat decisions of 2026-11-01 are recorded in OPEN_QUESTIONS.md and RUN_PLAN.md.
- open_questions: 0 open. Q34 approved (role registered, contract v13). Q39 recommendation applied (K23 reuses the preview scene file). Q44 recommendation applied (new draft PR on the new branch).
- units_done: round 1: 14 (T1 closed on CI's verdict, Q10). Round 2: R1, R2, R3 (browser check pending), R4, R7; R5 active until the module backlog units are done. Round 3: K0 to K9, K11, K12, K14, K18, K19, K19b, K20 (except K20f, parked until K29), K21, K22 (Q38), K25 (Q40 b), K26, K27. Partly done: K10 (live port, Q34), K13, K15, K16, K17, K28 (pending on B11). K30: guide written, PR refresh pending.
- owner_requests_done: the preset preview (two original renders, preset version 2, the nan loudness fix) and the cookbook plan (round 3 in RUN_PLAN.md, Q31). Done 20:30 UTC.
- next_wake_at: none. The loop no longer wakes per unit; the owner asked for one push when the version is verified.
- wake_trigger: none (the 16:57 wake was deleted when the owner asked for one push)
- watchdog_trigger: trig_013BHUFk1JYN8Lkt1nFRh3Fd (every two hours, fires into this session)
- last_entry: RUN_LOG.md, the entry for the owner's go on the three questions
- permissions: `.claude/settings.json` is written (round 2, Q9): full coding permissions, with the hard stops denied.
- sandbox: the browser step of the gate needs `GATE_ACCEPTANCE_NODE_OPTIONS` pointing at a Chromium wrapper. The session scratchpad that held it is gone; the wrapper must be recreated if the gate is run again.
- gate_in_progress: none.
