# Loop state

The first thing a wake-up reads. Keep it short. The coding-loop skill says how each field is used.

- status: running (round 2: the owner's answers of 2026-10-31; see RUN_PLAN.md round 2)
- branch: claude/nice-tesla-zrf6un
- pr: RTK23-dev/meridian#85 (draft, stacked on main at 0aa3301)
- started: 2026-10-29 00:09 UTC
- current_task: round 2, R5 (the 45 test-only modules, Q3). Done: the engine alerts (Q14), the batch planner (Q15) and the concurrency proposals (Q16, held at every size until calls record their bucket), all on /engine-ops. The four learning modules are explained, not wired, and wait for the owner (Q17; guardrails shows that test rows could reach learning). `studio/loop.ts` and `study/deep-study-service.ts` are explained, not wired (Q18). `production/route.ts`, `production/rework-engine.ts` and `production/voice-director.ts` are explained, not wired (Q19). `jobs/durable.ts` and `video/scene-frames.ts` are explained, not wired (Q20). `flow/nodes.ts` and `grading/priors.ts` are explained, not wired (Q21). `intelligence/cluster.ts` and `jev/calibration.ts` are explained, not wired (Q22). The `organic/*` group is explained, not wired (Q23): its entry point asks Apify for paid gathers. `quality/evidence.ts` and `shopify/reel-attribution.ts` are explained, not wired (Q24). `calibration/report.ts` is explained, not wired (Q25). `discovery/provenance.ts` is wired as "Where it was seen" on the Market stored pages (read-only, brand-scoped, PGlite-tested). `storage/filesystem.ts` and `vision/logo.ts` are explained, not wired (Q26). `a11y/contrast.ts` is in use by the token contrast test, so no change. `factory/cost.ts` is explained, not wired (Q27). `factory/render.ts` is explained, not wired (Q28), and `factory/benchmark-harness.ts` is in use by its test, so no change. The four engine modules (`firstLastFrame.ts`, `review-decision.ts`, `render/recorded.ts`, `review/take/gold.ts`) are explained, not wired (Q29). Next: `gates/slop-craft-gates.ts`, `lib/progress/*`, `lib/create/steps.ts`, `components/settings/connection-state.ts`, `render/splice-run.ts`. PR #85 is green (CI on 8d52d29), still a draft. R6 is parked. R8 waits for R5 and R6.
- units_done: 14 in round 1 (T10, T11, T2, the acceptance fix, T12, T3 non-secret reads, T4, T5, T6, T7, T8, T9a, T9b, T13). Round 2: R1, R2, R3 (browser check pending), R4 done; R5 at 6 wired and 33 explained (25 modules, plus the 8-file organic group) of the 45 listed, and 2 found in use by tests (contrast, benchmark); R7 done as a proposal.
- next_wake_at: 2026-10-31T19:37:00Z
- wake_trigger: trig_01YHngTh32fUdbRZxtcLMCnh (the previous one, trig_013MBDNEH4ZSVs8rJsVeoshr, fired at 19:15)
- watchdog_trigger: trig_013BHUFk1JYN8Lkt1nFRh3Fd (every two hours, fires into this session; recreated for round 2)
- last_entry: RUN_LOG.md, final entry (the run ends; the gate's stops are in the 07:12 and final entries)
- open_questions: 10 (see OPEN_QUESTIONS.md; Q13 is decided by the loop and asks for confirmation)
- permissions: `.claude/settings.json` is written (round 2, Q9): full coding permissions, with the hard stops denied.
- sandbox: the browser step of the gate needs `GATE_ACCEPTANCE_NODE_OPTIONS` pointing at a Chromium wrapper. The session scratchpad that held it is gone; the wrapper must be recreated if the gate is run again.
- gate_in_progress: none. The gate has stopped without a verdict twice in the detached runs (see the 07:12 entry).
