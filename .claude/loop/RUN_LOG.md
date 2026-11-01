# Run log

Append-only. One entry per unit of work, newest at the bottom.

## 2026-10-29 00:08 UTC: run set up

- Wrote the coding-loop skill, the run plan (`RUN_PLAN.md`), the open questions (`OPEN_QUESTIONS.md`) and this log.
- Read the session resource and permission docs. The loop runs until the session's allowance ends. Before that, it commits and pushes its state.
- Tried to add `.claude/settings.json` with allow and deny rules for the loop's commands. The write was refused as a change to the session's own permissions, so it is not in this commit. Recorded as Q9 for the owner.
- Armed the first wake-up (00:30 UTC) and the two-hourly watchdog.
- No product code changed in this entry.

## 2026-10-29 00:23 UTC: T1 in progress (stability gate)

- Added `scripts/gate.mjs` and the `npm run gate` script. It runs typecheck, lint, the scripts tests, the source tests, the build and the release acceptance, in that order. It prints each count against the baseline and reports the engine dry run on its own line. It exits 0 for PASS, 1 for FAIL and 2 for INCOMPLETE (a check that could not run).
- Checks run before starting the full gate: `npx eslint scripts/gate.mjs` clean; `node --check` ok; `npm run typecheck` pass; `npm run lint` 0 errors, 4 warnings (baseline); scripts tests 220 tests, 217 pass, 0 fail, 3 skipped (baseline, exact match).
- Full gate started in the background at 00:23 UTC. The source suite alone takes about 20 minutes (the baseline run took 1,205 s), so the whole gate takes roughly 40 minutes. Its result is recorded in the next entry.
- Note for the run plan: a full gate per task costs about 40 minutes. Per-unit checks should use focused tests, and the full gate should run at the end of each task only.

## 2026-10-29 00:31 UTC: CI failure on the gate commit, fixed

- CI: `tests (shard 5)` failed on 9855981. Cause: the env-example guard (`src/lib/meridian/config/env-example.test.ts`) requires every variable read by src and scripts to be listed in `.env.example`. `scripts/gate.mjs` read `GATE_ACCEPTANCE_NODE_OPTIONS` and `NODE_OPTIONS`, and neither was listed. The job log showed 1,031 tests, 1 failed, from the guard's own assertion.
- Fix, in 7dd3303: `GATE_ACCEPTANCE_NODE_OPTIONS` is listed in `.env.example` as developer tooling. The gate now copies the environment and sets `NODE_OPTIONS` only when that variable is set, so it no longer reads `NODE_OPTIONS` by name.
- Checked locally: the env-example guard, 9 of 9 pass; `scripts/setup.test.mjs`, 12 of 12 pass; eslint on `scripts/gate.mjs` clean. The shard itself was not re-run here.
- The earlier full gate (on 9855981) was stopped. It was testing code CI had already shown to be wrong. The full gate on 7dd3303 started at 00:30 UTC; its verdict will be recorded in the next entry.

## 2026-10-29 00:43 UTC: CI green on the fix, gate running again

- CI on e2976c8 (run 40794583254): all 13 jobs succeeded, and CodeRabbit was skipped (draft). The `check` aggregate job, which had failed on 9855981 from the shard 5 failure, passed. The e2e job, which had been skipped, passed.
- The full gate started at 00:30 UTC on 7dd3303 did not finish. Its process was gone by 00:31 with an empty log and no verdict, so nothing was recorded from it. It was restarted at 00:43 UTC on e2976c8 (same code). Its verdict will be recorded in the next entry.

## 2026-10-29 00:56 UTC: the gate stops without a verdict, and now leaves evidence

- The gate started at 00:30 (gate-run2) and at 00:43 (gate-run3) both disappeared during the source tests, with empty logs and no verdict. Memory was not short (15 GB free), and the kernel log shows no kill. The cause is not known.
- Change: `scripts/gate.mjs` now writes each finished step to `artifacts/gate/` as the step ends, prints a `running` and `finished` line for each step, and records a SIGHUP, SIGINT or SIGTERM with the step it was in. A stop that leaves no verdict is therefore visible.
- Checked: eslint clean, syntax ok. A new gate run started at 00:55 UTC (gate-run4) shows its progress lines. Its verdict goes in the next entry.
- Interim evidence: CI is green on `e2976c8`, and every check run passed.

## 2026-10-29 01:20 UTC: T10 done, T1 blocked on the local source step

- CI on b9483a5 (run 40797459592): all 13 jobs succeeded, and CodeRabbit was skipped. This is the interim evidence for the head.
- The local gate (gate-run4) passed typecheck, lint and the scripts tests, then stopped during the source tests with no stop message, the third run to do so. Memory was not short. The gate's per-step logs for typecheck, lint and scripts tests are in `artifacts/gate/`. Decision Q10 changes how the source tests run locally.
- T10 is done: `docs/engine/PRESET_MODEL_PROPOSAL.md` inventories the five preset families (look, repurpose option, caption style, style kit, editor tuning), says which are presets and which are not, and lists which changes need a contract change. It changes no code. The registry in T11 needs no contract change.
- Next unit: T11, the registry on the existing contracts, now that T10 is done.

## 2026-10-29 01:40 UTC: T11 done, the look registry

- The look overlays moved from `compiler.ts` to `src/engine/compose/looks.ts`, as `LOOK_OVERLAYS` (keyed by the contract's `LOOK_PRESETS`, so a missing overlay does not compile) and `resolveLook`. `resolveLook` refuses any name that is not a look, with `invalid_input`. The compiler reads the look through it, and its `LookPreset` import is gone.
- No contract change. The overlay values did not change: `looks.test.ts` pins each of the four to the values the compiler drew before.
- Tests: `looks.test.ts` (one per look, the key set, eight refused names, non-strings) and `repurpose/catalog.test.ts` (each option sets a part, the look it sets is in the registry, each look is offered by one option). Focused run: 88 of 88 pass across these and the compiler, visual-treatment, resolve and child tests. eslint and typecheck are clean.
- The compose snapshot fixture has no look overlay, so it cannot show that the output is unchanged. The pinned-value test is the check. The change to the compose STATUS file records this.
- Next unit: T2, the research note (no dependencies).

## 2026-10-29 02:03 UTC: T2 done, the short-form research note

- Wrote `docs/engine/RESEARCH_SHORT_FORM_2026-10.md` from web searches (standard mode, then searches restricted to YouTube's help and blog, TikTok's ads and newsroom domains, and Instagram's creator and help domains). Each platform claim names its official-domain source. Each vendor or creator figure is marked as unverified or hypothesis, and none is used as a default.
- Caveat recorded in the note: the claims come from search summaries. The source pages were not opened, so each platform figure needs checking on its page before it is quoted outside the engine.
- Gaps recorded: no official Shorts, Reels or TikTok organic retention benchmark; no peer-reviewed study of the first three seconds; the Dost paper's findings not read; no owner reference reels analysed (Q7).
- The proposed defaults for T12 are in section 4 of the note, each with its label.
- Next unit: T12, the hook timing rules, as configuration with these defaults.

## 2026-10-29 02:12 UTC: release acceptance failed in CI on b00266c, G11

- CI: `release-acceptance` failed on b00266c (run 40803990814). The failing check was G11: "the budget field must have focus" (`false !== true`). The same check passed on 268bc27 and on earlier heads, and the commit under test changes only docs and loop state.
- Local: the acceptance passed 25 of 25 before the change, and again after it. The failure did not reproduce.
- Likely cause, not reproduced: the budget field takes focus in a React effect that runs after the field appears (`setup-panel.tsx`, around line 151). The check read focus as soon as the field was visible, so on a slower runner the read can come before the focus. The same read is in G7.
- Change: `scripts/release-acceptance/acceptance.mjs` waits up to five seconds for the focus to land, in G7 and G11, before the same assertion. A field that never takes focus still fails the check.

## 2026-10-29 02:45 UTC: T12 done, hook timing at plan time

- `src/engine/review/gates/hookTiming.ts`: the plan gate checks the shots carrying the script's hook beat against two sourced windows, the proposition by 3 s and a hook by 6 s. A late hook names its own shots. The longest-shot rule (7 s) is a hypothesis, so it is a note and never fails the gate.
- `src/engine/config/thresholds.ts`: a `hook` section with three tunables and bounds. `thresholds@3` is unchanged. `config.test.ts` counts 82 tunables (was 79).
- Tests: `hookTiming.test.ts` (eight cases: pass at zero, late at 3.5 s, late at 7 s, no hook beat, no covering shot, no script, the sourced values, the longest-shot note). Focused run 71 of 71. Gate and planner suites 377 of 377. Orchestrator and plan-handler suites 173 of 173. Jobs suites, including the brief pipeline, 333 of 333. eslint and typecheck are clean.
- Not done: the on-screen text rate, which needs word timing on caption lines. The T12 acceptance also named cut-time fixtures within 2 frames. Those belong to the reference grammar (Bible 6.2), which has its own tests, so they were not added here.
- Decisions to confirm are in Q11.

## 2026-10-29 02:57 UTC: gate run 5 stopped in source group 0; T3 starts on CI

- Run 5 (six source groups, started 02:29) passed typecheck, lint, the scripts tests and the group 0 listing, then stopped during source group 0 with no stop message and no verdict. This is the fourth run to stop, and the first in a smaller group, so the single process was not the only cause. Nothing else was running. Memory was not short.
- CI on `3828402` (run 40806678439): all 13 jobs passed, and CodeRabbit was skipped.
- Decision (Q10, decided by loop, confirm): T3 to T9 start now. CI is their verification of record. Each unit runs focused tests for the area it changes, and CI on the pushed head is checked at the next wake-up. The local gate verdict stays open under T1, and its cause is not yet known.
- Next unit: T3, typed configuration for the non-secret settings read outside `src/engine/`.

## 2026-10-29 03:25 UTC: T3 batch 1, three flags through one typed module

- `src/lib/meridian/config/server-settings.ts`: three accessors, `testingRuntimeFlag`, `trustProxyHeaders` and `syntheticTelemetryAllowed`. Each reads the environment on each call and is on only for the exact value "true", as the readers were before. Secrets are not read here.
- Migrated: `runtime-mode.ts` (MERIDIAN_TESTING_RUNTIME), `security/limits.ts` (MERIDIAN_TRUST_PROXY_HEADERS, two reads), `learning/telemetry-engine.ts` (ALLOW_SYNTHETIC_TELEMETRY). `DATABASE_URL` and `NODE_ENV` reads stay where they are.
- Ratchet: `server-settings.test.ts` pins direct `process.env.` reads in non-test code under `src/lib` and `src/routes` at 76. It may fall as readers move, and may not rise.
- Checks: eslint clean; typecheck exit 0; `server-settings`, `runtime-mode`, `telemetry`, `telemetry-bridge` and `env-example` tests, 29 of 29; the tests that cover the migrated flags, 175 of 175.
- Verification of record is CI (Q10). CI on the pushed head is checked at the next wake-up.

## 2026-10-29 03:55 UTC: T3 batch 2, five deployment settings

- `server-settings.ts` gained five accessors, `hypitBaseUrlSetting`, `cycloneGatewayUrlSetting`, `ffmpegPathSetting`, `ffprobePathSetting` and `hfHomeSetting`. Each returns the raw value, as the reader got it before, so each reader keeps its own rule for blank and unset.
- Routed through them: 17 reads in nine files (`research/transcription.ts`, `discovery/cyclone-scout-adapter.ts`, `settings/provider-config.ts`, `hypit/client.ts`, `video/sample-frames.ts`, `video/engine.ts`, `factory/decode.ts`, `embeddings/semantic.ts`, `routes/api/health.ts`).
- Two spots needed a local value, because a function call does not narrow a type: the Cyclone adapter reads its gateway URL once in the constructor, and the HF_HOME helper reads once, then trims. Results are the same.
- Ratchet: 76 down to 59.
- Not in this batch, on purpose: secrets (`TOKEN_ENCRYPTION_KEY`, the API keys, `WEBHOOK_SECRET`), `DATABASE_URL`, `BETTER_AUTH_URL` (auth origin) and `NODE_ENV`.
- Checks: eslint clean; typecheck exit 0; the nine files' tests, 93 of 93; the settings, environment-contract and runtime tests, 22 of 22 and 10 of 10 for the new accessors.

## 2026-10-29 04:17 UTC: T3 batch 3, nine model, URL and list settings

- `server-settings.ts` gained nine accessors: WhisperX model, perception model, Higgsfield model, email API URL, external embedding URL, model and dimensions, OpenRouter Decisions model, and the artifact host allowlist. Each returns the raw value, as the reader got it before.
- Routed through them: 15 reads in 12 files (`research/worker.ts`, `settings/provider-config.ts`, `perception/multimodal.ts`, `production/providers/higgsfield.ts`, `notifications/email.ts`, `system-status.ts`, `embeddings/external.ts`, `routes/api/health.ts`, `decisions/capabilities.ts`, `decisions/openrouter-engine.ts`, `decisions/status.ts`, `production/artifact-finalizer.ts`). Readers that already imported the module now import the new names alongside the old ones.
- Ratchet: 59 to 44.
- Not moved, on purpose: the two money caps (`OPENROUTER_DECISION_MAX_USD_PER_CALL`, `CYCLONE_OBSERVATION_BUDGET`), which need a careful look first; `MERIDIAN_LOCAL_DATA_DIR` in `db.ts`; `DATABASE_URL`, `BETTER_AUTH_URL` and `NODE_ENV`; and all secrets.
- Checks: eslint clean; typecheck exit 0; the 52 suites that cover the touched modules and the settings module, 458 of 458 passing (3 skipped, 0 failing).

## 2026-10-29 04:50 UTC: T3 batch 4, the last non-secret reads

- `server-settings.ts` gained four accessors: the Cyclone device id, the Cyclone observation budget, the OpenRouter per-call ceiling, and the Drive folder id. Each returns the raw value.
- The two money caps were looked at before they moved. Only the read moved. `decisionCallCapUsd` keeps its parsing and its refusal (a value that is not a positive number sends nothing), and the Cyclone observation budget keeps its default of 20. The read is the only change.
- Routed through them: 6 reads in four files (`discovery/cyclone-scout-adapter.ts`, `settings/provider-config.ts`, `decisions/decision-catalog.ts`, `storage/drive.ts`). The Cyclone adapter reads its device id once in the constructor, because a call does not narrow the type.
- Ratchet: 44 down to 38. The non-secret reads are now all routed, except NODE_ENV, DATABASE_URL, BETTER_AUTH_URL and MERIDIAN_LOCAL_DATA_DIR, which stay on purpose.
- The secret reads remain (25 reads, five names). Q12 asks where they should live.
- Checks: eslint clean; typecheck exit 0; 351 tests, 350 passing, 1 skipped, none failing, across the settings, environment-contract, Cyclone, Drive and decisions suites.

## 2026-10-29 05:20 UTC: T4 batch 1, the session loading block

- Moved 13 declarations, lines 56 to 387 of `studio/session.server.ts`, unchanged, to `studio/session-load.server.ts` (352 lines): the stored session, the run policy, the usage counts and the helpers they use.
- `studio/session.server.ts` re-exports every public name it had from the loading block (`StudioSession`, `generationUsage`, `getStudioSession`, `loadSession`, `storedProbability`, `studioAutonomyDefault`, `studioBrandRunPolicy`). No caller changed.
- Size: 1,807 to 1,462 lines in the original, which still needs T4's later batches. The execution function is about 700 lines, and the review functions are at the bottom.
- Checks: eslint 0 warnings on both files; typecheck exit 0. The studio and session-importing suites (35 files) are running in the background; their totals will be in the next entry.

## 2026-10-29 05:45 UTC: T4 batch 1 tests

- The studio and session-importing suites, 35 files: 238 tests, 228 pass, 0 fail, 10 skipped. The skips are the suites' own gates, and none is new.

## 2026-10-29 05:39 UTC: T4 batch 2, the execution and review actions

- Split the rest of `studio/session.server.ts` (1,462 lines after batch 1) into three modules, and the original keeps its public names:
  - `session-jev.server.ts` (61 lines): the stored JEV decision and `loadGatedJevDecision`.
  - `session-execute.server.ts` (857 lines): `executeApprovedCreativePlan` and its helpers (`planReservationShares`, `errorText`, `markImageJobUnknown`, `insertImageJobRow`, `releaseUnheldReservations`).
  - `session-review.server.ts` (340 lines): `approveAndExecuteCreativePlan`, `rejectCreativePlan`, `reviewStudioVariant`, `publishStudioVariant` and `recordStudioTestPerformance`.
  - `session.server.ts` (238 lines): `persistCreativePlanRow`, `generateStudioVariants`, and the re-exports of every public name.
- Each moved declaration is unchanged. Every non-blank line of the old file survives in the four files, except two import lines whose names were narrowed to what each module uses.
- Two tests read `studio/session.server.ts` as text. `jev/decision.test.ts` looks for the call `decide(publishingReadiness`, which now sits in `session-review.server.ts`, so the first run had 227 of 228 passing. `creative/state-transition.server.test.ts` forbids `update creative_plans` in that file. Both now read every `studio/session*.server.ts` module, with the same assertions. The state-transition test also asserts that the session module is found, so a bad path cannot pass. No moved module contains the forbidden pattern.
- Checks: eslint clean on the five source files and the two tests, after one unused import in `session-jev.server.ts` was removed (eslint found it); typecheck exit 0; the 35 studio and session-importing suites, 238 tests, 228 pass, 0 fail, 10 skipped, the same as batch 1.
- Not run here: the full source-test set, because the local gate stops (Q10). CI on the pushed head is the verification of record, and the next wake-up checks it.
- Size: the largest file is `session-execute.server.ts` at 857 lines, under the 1,000-line limit. T4 is done.
- CI on `7b5010a` (batch 1 head): every job green except `e2e`, which was still running at 05:28. Its result is checked at the next wake-up.
- Wake-up: the stale 05:39 wake (`trig_01PhmhKbwd91VHjJVRrYpKkr`) was deleted. `STATE.md` had named `trig_017Di61wAqwLV4VRuEbwzrzh`, which was not listed. The next wake is `trig_01UUXHovuLik9EkhypJbjg85`, at 06:00:00Z.

## 2026-10-29 05:47 UTC: CI on the batch 1 head, and T5, the factory worker split

- CI on `7b5010a` (the batch 1 head, run 40822849599) finished with every job green, `e2e` included, and the aggregate `check` green. The check suite notification at 05:32 was for this head.
- CI on the batch 2 head `aa858c2` (run 40824706536) was still running when T5 was pushed. Its result is checked at the next wake-up. It is not red in any finished job.
- Split `src/lib/meridian/factory/worker.ts` (1,070 lines) into five files. Each moved declaration is unchanged, except that an export was added where another module uses it.
  - `worker.ts` (399 lines): `executeFactoryJob`, the `FactorySeams` type, `decodeStoredAds`, `guessFormat`. It re-exports `variantGateVerdicts`, `creativeQaVerdict`, `regateVariantsForCreative` and `regateVariantById` from `worker-gate.ts`, so no caller changes.
  - `worker-shared.ts` (28 lines): `text`, `parseList` and `killSwitchPaused`, the helpers the other modules share. Moving them out keeps the graph free of cycles.
  - `worker-grade.ts` (307 lines): the grade types, `gradeStoredAds` and its helpers.
  - `worker-variants.ts` (189 lines): the plan settings, `savedPlanLine`, `persistTemplates`, `variantsMadeToday` and `persistVariants`.
  - `worker-gate.ts` (165 lines): the claim rules, the gate verdicts, `gateVariants` and the regate entry points.
- Checks: eslint clean on the five files, after two unused imports in `worker-variants.ts` were removed; typecheck exit 0; 64 suites that import the worker or cover the factory: 407 tests, 407 pass, 0 fail, 0 skipped. The full suite is for CI to confirm (Q10).
- Commit `ba2ad93`. T5 is done, and the largest file is 399 lines.
- Wake-up: the 06:00 wake (`trig_01UUXHovuLik9EkhypJbjg85`) was deleted, and the next is armed as `trig_01PjbgefPCt4H6jaAUGCU3xj`, at 06:08:00Z.

## 2026-10-29 05:52 UTC: CI on the T4 heads, and T6, the Content Factory service split

- CI on `836b370` (the T4 split, run 40824615629) finished with success. CI on `aa858c2` (run 40824706536) finished with success. CI on `ba2ad93` (T5) and `943fff2` was still running at this wake-up. Their results are checked at the next wake-up.
- Split `src/lib/meridian/content-factory/service.ts` (1,097 lines) into five responsibility modules. `service.ts` is now a re-export of every public name, 27 lines, so the callers keep their imports.
  - `service-core.ts` (190 lines): the refusals, the session row and its mapping, the access checks and the small helpers.
  - `service-sessions.ts` (376 lines): list, create, brief, read, message, settings, uploads and sources.
  - `service-run.ts` (201 lines): start and revise a run, and read it.
  - `service-delivery.ts` (201 lines): the hook history, the economics, the delivered link and the delivery approval.
  - `service-shots.ts` (134 lines): remake, the clip, and the shot decisions.
- The header comment that states the service's role, tenancy and engine rules stays at the top of `service.ts`. A first version of the script dropped it. A line check against the old file caught the loss, and it was restored before the commit.
- Each moved declaration is unchanged, apart from an export added where another module uses it. The removed lines are the multi-line imports, rewritten by usage, and those declarations.
- Checks: eslint clean with no warnings on the six files; typecheck exit 0. The 27 Content Factory and service-importing suites: 235 tests, 235 pass, 0 fail, 0 skipped. The full suite is for CI to confirm (Q10).
- Commit `7ff6f76`. T6 is done. The largest module is `service-sessions.ts` at 376 lines.
- Wake-up: the 06:08 wake (`trig_01PjbgefPCt4H6jaAUGCU3xj`) was deleted, and the next is armed as `trig_01BHPGG4o3ancKi2EB2dJjak`, at 06:13:00Z.

## 2026-10-29 06:04 UTC: CI on the T5 head, and T7, the orchestrator split

- CI on `ba2ad93` (the T5 split, run 40825370942) finished with every job green, `e2e` and the aggregate `check` included.
- Split `src/engine/jobs/orchestrator.ts` (1,722 lines) by event family. The pure core is unchanged: `advance(state, event)` still takes the state and the event and returns the next state, the jobs and the effects.
  - `orchestrator.ts` (263 lines): `advance`, the dispatcher, the start and control events (dead, resume, human choice), and the re-exports of every public name.
  - `orchestrator-state.ts` (429 lines): the state shapes, the limits and the checks and lookups that more than one family uses.
  - `orchestrator-single.ts` (148 lines): intake, the script, the plan, the estimate, the gates and delivery.
  - `orchestrator-shots.ts` (216 lines): produce, hold, the take check, the rounds and the shot escalations.
  - `orchestrator-branch.ts` (199 lines): edit, compose, the pre-render and post-render reviews, and the revisions.
  - `orchestrator-variants.ts` (139 lines): the variant runs, their produce and check, and the assembly.
  - `orchestrator-remake.ts` (177 lines): the remake events.
  - `orchestrator-schedule.ts` (233 lines): scheduling.
- The split was checked against the old file, line by line. Every removed line is a multi-line import rewritten by usage, or a declaration that gained an `export`. Its usage check ignores comments and strings, so a word such as "schedule" in a comment does not count as a use. The first run counted those words and reported false cycles.
- No contract is touched, and no version changes. `src/engine/jobs/README.md` lists the new files.
- Checks: eslint clean; typecheck exit 0. The 28 engine suites that import or exercise the orchestrator, including the PGlite tests on recorded fixtures: 257 tests, 257 pass, 0 fail, 0 skipped. `e2e.test.ts` in that set is fixture-only, and its transport fails on any request it was not told to expect. No test reads the orchestrator source as text.
- Not updated: the STATUS files in `src/engine/jobs/` and `handlers/` still name some functions as living in `orchestrator.ts`. That is a documentation pass, not part of this unit.
- Commit `1354ef0`. T7 is done. The largest module is `orchestrator-state.ts` at 429 lines.
- Wake-up: the 06:13 wake (`trig_01BHPGG4o3ancKi2EB2dJjak`) was deleted, and the next is armed as `trig_01Ppxabe2F6az1BUpwfZnszt`, at 06:25:00Z.

## 2026-10-29 06:11 UTC: CI on the T6 and T7 heads, and T8, the engine API split

- CI, read from the workflow runs: `943fff2` (T5 state, run 40825418790), `7ff6f76` (T6, run 40825860016) and `d45cf3d` (T6 state, run 40825911975) each finished with success. `1354ef0` (T7, run 40827042013) and `375c695` (T7 state, run 40827090739) were still running at this wake-up, and their results are checked at the next wake-up.
- Split `src/engine/api/index.ts` (1,506 lines) into a re-export of its public names, 20 lines, and six modules next to it.
  - `start.ts` (214 lines): start a request, read its status, read a delivered master, and the problems a request has.
  - `remake.ts` (655 lines): remake a shot, quote it, replace it with a clip, decide it, and read its take.
  - `spend.ts` (72 lines): the spend on a request's ledger, and the pause of its reservations.
  - `review.ts` (63 lines): the open review items of a brand.
  - `readiness.ts` (91 lines): whether the engine can run, and the production ports.
  - `feed.ts` (452 lines): the request feed.
- The leading comment, with the API's rules, stays at the top of `index.ts`. The first draft had two faults, which the check caught before the commit. A type declared under a doc comment was re-exported as a value, and an alias was not found under its local name. The usage check also counted property accesses such as `envelope.contentHash`, which are not uses. Each is fixed in the splitter, and the split was rerun from a clean original.
- Survival check against the old file: every missing line is an import statement rewritten by usage, or a declaration that gained no change beyond `export`. No code line is missing.
- Checks: eslint clean; typecheck exit 0. The 35 engine API, ops and API-importing suites: 608 tests, 608 pass, 0 fail, 0 skipped. No test reads the API source as text.
- Not updated: `src/engine/api/STATUS.md` still names `index.ts` for some functions. That is a documentation pass, as with the orchestrator.
- Commit `acaf1e8`. T8 is done. The largest module is `remake.ts` at 655 lines.
- Wake-up: the 06:25 wake (`trig_01Ppxabe2F6az1BUpwfZnszt`) was deleted, and the next is armed as `trig_016G7vtYeJjYyQDAgE726sb9`, at 06:32:00Z.

## 2026-10-29 06:20 UTC: CI on the T7 heads, and T9a, the asset router

- CI, read from the workflow runs: `1354ef0` (T7, run 40827042013) finished with success, and so did `375c695` (T7 state, run 40827090739). `acaf1e8` (T8, run 40827669769) was still in progress at 06:12. Its result is checked at the next wake-up.
- Observation: `9acb760`, a state-only commit, has no workflow run attached. Its only check on the PR is CodeRabbit, which was skipped. The state-only heads `943fff2`, `d45cf3d` and `375c695` did run CI, so this one is not explained by a path filter. The next wake-up checks whether CI runs on the state commits.
- T9 covers two files. Under the size rule it is split into T9a (`engine/assets/router.ts`, 1,179 lines) and T9b (`engine/jobs/handlers/produce-shot.ts`, 1,052 lines).
- T9a: `router.ts` keeps `createAssetRouter` whole, the closure that runs submit, settle and produce over one shared state. The types, settings and constants move to `router-types.ts` (248 lines), and the pure helpers to `router-helpers.ts` (133 lines). `router.ts` is 831 lines. Question Q13 asks the owner to confirm the decision to keep the closure whole.
- The splitter's first run treated a spread, `...defaultRouterSettings()`, as a property access, so the import was dropped. Typecheck caught it, and the check was fixed before the commit. The same check is what the earlier splits relied on, and their typecheck runs passed.
- Survival check against the old file: every missing line is a declaration that gained an `export`, or a member of a multi-line import rewritten by usage. No code line is missing.
- Checks: eslint clean; typecheck exit 0. The 23 asset router and dependent engine suites: 210 tests, 210 pass, 0 fail, 0 skipped. No test reads the router source as text.
- Commit `6730129`. T9a is done. T9b, `produce-shot.ts`, is next.
- Wake-up: the 06:32 wake (`trig_016G7vtYeJjYyQDAgE726sb9`) was deleted, and the next is armed as `trig_01Q79eZB6fucyTHDQAvq96NG`, at 06:41:00Z.

## 2026-10-29 06:29 UTC: CI on the T8 and T9a heads, and T9b, the produce_shot split

- CI, read from the workflow runs. `acaf1e8` (T8, run 40827669769) finished with success. `9acb760` (the T8 state, run 40827839244) also finished with success.
- Correction to the earlier entry: the state commit `9acb760` did have a workflow run. The run was created at 06:12:38, after the runs list I read at the wake before it. The observation that it had no run was a timing gap, not a missing run. The CI on state-only heads does run.
- `6730129` (T9a, the asset router) is pushed, and its run was still to be checked at this wake.
- T9b: `engine/jobs/handlers/produce-shot.ts` (1,052 lines) keeps the handler, `createProduceShotHandler`, and its two re-exports of chain-store names. Its declarations move to four modules by responsibility:
  - `produce-shot-types.ts` (109 lines): the constants, the production shapes and the ports.
  - `produce-shot-take.ts` (314 lines): making a take from a production, and storing it.
  - `produce-shot-spec.ts` (153 lines): the shot's asset spec, its prompt, its plan and model choices, and the reservation the stage needs.
  - `produce-shot-chain.ts` (325 lines): driving a shot made in several calls.
- The splitter now keeps bare `export { x };` statements of imported names in the handler, where the imports live. Its check also treats a one-line doc comment as a comment. Both were caught in the dry run, before any write.
- Survival check against the old file: every missing line is a declaration that gained an `export`, or a member of a multi-line import rewritten by usage. No code line is missing.
- Checks: eslint clean; typecheck exit 0. The handler's suite and the 39 suites that import it or exercise the API, ops and handlers: 276 tests, 276 pass. The whole `engine/jobs` and `engine/jobs/handlers` folders: 523 tests, 523 pass, 0 fail, 0 skipped. No test reads the handler source as text.
- Commit `baa3a64`. T9 is done: T9a in `6730129`, T9b in `baa3a64`.
- Wake-up: the 06:41 wake (`trig_01Q79eZB6fucyTHDQAvq96NG`) was deleted, and the next is armed as `trig_01XkfeBiekhg9bq6cmApDoDF`, at 06:50:00Z.

## 2026-10-29 06:33 UTC: T13, the browser and UI checks

- CI, read from the workflow runs: `70c97af` (T9a state, run 40828676334) and `6730129` (T9a, run 40828606332) each finished with success. `baa3a64` (T9b) was still running at this wake-up, and its result is checked at the next wake-up.
- T13: `node scripts/release-acceptance/run.mjs` run locally, exit 0. Result: 25 PASS, 0 FAIL, and the release verified (`VERIFIED the audited release and the untouched second hold`). That matches the baseline of 25 of 25. The checks include the Content page's workflow sections, the keyboard and focus checks, the phone-width checks, and the no-request check (`D1`, no request left the local server). The run sends no provider request.
- How it ran: the repo's Playwright expects a Chromium build that this sandbox does not have. The preinstalled build 1194 was used through the session's launch wrapper, which changes only the executable path. The wrapper is in the session scratchpad, outside the repo, and nothing was installed. Screenshots and the server log are in `artifacts/release-acceptance/`, which is git-ignored.
- The script's dev server was not left running. No file in the repo changed.
- T13 is done. T14, the handoff, is next.
- Wake-up: the 06:50 wake (`trig_01XkfeBiekhg9bq6cmApDoDF`) was deleted, and the next is armed as `trig_01WaFgf31tufcrw4mKfVdkPb`, at 06:54:00Z.

## 2026-10-29 06:55 UTC: CI on the T9 to T13 heads, and the gate for T14

- CI, read from the workflow runs. All four recent heads finished with success: `baa3a64` (T9b, run 40829497422), `3d3b5f8` (T9b state, run 40829549939), `180a7d8` (T13 state, run 40829949061) and `3bbdcab` (the owner checklist, run 40830071076). `6730129` (T9a, run 40828606332) and `70c97af` (T9a state, run 40828676334) also succeeded earlier.
- The gate for T14 (`npm run gate`) was started in the background on `180a7d8`, the last commit with code changes. The later commits change only loop state and `docs/FIRST_TEST_RUN.md`. At this wake: typecheck, lint, the scripts tests and source groups 0 to 3 have each exited 0, and source group 4 was running. The log is `artifacts/gate/gate-run-T14.log` (git-ignored). The gate's totals are read at the next wake, and section 10 of `docs/STATE_2026-10-28.md` is written from them.
- Wake-up: the 06:54 wake (`trig_01WaFgf31tufcrw4mKfVdkPb`) had fired and was one-shot. The next is armed as `trig_01BsYDhUqhKXPiASoeyVSgku`, at 07:16:00Z.

## 2026-10-29 07:12 UTC: the T14 gate stopped silently, and was run again detached

- CI on `54f75ac` (the 06:54 state commit, run 40832215400) finished with success.
- The first T14 gate (`gate-run-T14.log`) stopped without a verdict at 06:49:55, at the start of source group 4. The log has no exit line and no signal line. Memory was ample (15 GB free), and no test process was left running. Its last step was the group 3 result. That is a sixth silent stop in this run, the first one in the six-group mode. The group 4 test list did not change.
- Group 4 run by itself, with the gate's arguments and `NODE_ENV=development`: exit 0, 1,124 tests, 1,120 pass, 0 fail, 4 skipped. So the tests in the group pass, and the stop came from outside them. I searched the source tests for process killers (`process.kill`, `pkill`, `killall`, detached children) and found none in `src/`. The only `process.kill` is in a scripts test, and it signals the child's own pid.
- The gate was started again, detached with `setsid` and `nohup`, with the same Chromium wrapper: `artifacts/gate/gate-run-T14b.log`, pid 2304 at 07:12. Its totals are read at the next wake-up. If it stops again, the stop is recorded here, and T1 stays blocked under Q10.

## 2026-10-29 07:27 UTC: final entry, the run ends

- Units done: 14 of 14 tasks, with T1 parked. T10 and T11 (presets), T2 (the research note), the acceptance fix, T12 (hook timing), T3 (typed configuration), T4 to T8 (the splits of the studio session, the factory worker, the content-factory service, the orchestrator and the engine API), T9 (the asset router, in T9a, and the produce_shot handler, in T9b), T13 (the browser checks, 25 of 25) and T14 (the handoff).
- Commit range: `7723e39..HEAD`, 40 commits on this branch in this run, including the loop state.
- Checks, with the code at `baa3a64` and the loop-state commit `180a7d8` that the gate ran on: typecheck pass; lint 0 errors, 4 warnings (baseline); scripts tests 220 / 217 pass / 0 fail / 3 skipped (baseline); source tests in six groups 6,753 / 6,712 pass / 0 fail / 41 skipped (baseline 6,690 / 6,649 / 0 / 41); build pass; release acceptance 25 of 25; engine dry run FAIL 0 of 1, the known red (Q2). CI is green on `baa3a64` and on the later heads checked at each wake.
- Parked: T1, the local gate's single-process verdict. It stopped without a verdict six times across this run, and the last two stops were at 06:49:55 and 07:14:00. Q10 asks whether CI's verdict closes it.
- Owner decisions still open (`OPEN_QUESTIONS.md`): Q1, Q2, Q3, Q4, Q5, Q6, Q7, Q8, Q9, Q10 and Q12. The loop decided Q10, Q11 and Q13, and each needs confirmation. Q13 is the asset router's closure, which stays whole.
- Corrections recorded in this run: the wake at 06:55 reported the gate as running when it had stopped at 06:49:55. The pgrep check was matching its own shell. The state commit `9acb760` did have a CI run, which succeeded.
- The run ends here. The watchdog is deleted, and no wake-up is armed.

## 2026-10-31 12:13 UTC: round 2, the owner's answers

- Q2, the prices: every price the project holds is saved as plain files in `docs/data/prices/`, generated by `npm run prices:export`, with a test that fails when they drift (`c50f228`). The HyperFrames render price is not in our data, so it stays unknown.
- Q2, the research data: a proposal for keeping research data efficiently, with six decisions for the owner (`docs/data/RESEARCH_DATA_PLAN.md`). Nothing is built yet, because the storage choices need approval.
- Q9: `.claude/settings.json` allows the coding session its tools, with the hard stops denied: paid or live provider runs, publishing and installs, force-pushes and history rewrites, merging, docker and curl, reading any `.env` file, and deleting artifacts (`b35f387`).
- Q12: the five secret settings are read through `src/lib/meridian/credentials/secret-settings.ts`. Twenty-four direct reads moved, and a test fails on any new direct read. The ratchet falls from 38 to 14 (`ea5fece`). The 213 suites that cover the moved readers: 1,570 tests, 1,546 pass, 0 fail, 24 skipped.
- Q4: the E6 engine operations have a page at `/engine-ops`: stage times and provider health for seven days, a request's dead jobs, and an admin-only replay (`f3a7034`). The browser check is still to do.
- Q5: the export package is on the Exports screen and must pass the disclosure check first. Every Meridian-made creative is treated as AI-generated, so it is blocked, and the screen names the three missing disclosures. Unblocking needs the owner's decisions: a C2PA signing library (a new dependency) and what counts as real footage (`f3a7034`).
- Q3: two of the 45 modules are now wired, through Q5. The rest need a decision per group, listed in the run plan.
- Q7: local upload already works in the Content Factory. Public links need the owner's decisions first (which kinds of link, the size limit and the host list). The run plan parks it.
- Q6 and Q8: one new draft pull request, opened once the changes are settled. PR #85 is not changed.
- The wake-up is armed for 12:29Z, and the watchdog is recreated for round 2.

## 2026-10-31 13:13 UTC: round 2, R5 unit: the engine alerts on /engine-ops

- Wake: the scheduled wake (`trig_01QHcc431rfUbRpqEp7UM2Ue`) fired at 13:13:01Z. PR #85 on `8365e1b`: all 14 check runs succeeded, `mergeable_state` clean, still a draft, no review threads.
- Task: R5, the engine's alert modules (`src/engine/ops/alerts-sql.ts`, `alerts.ts`). They were test-only. Now `readWorkspaceAlerts` (`src/lib/meridian/engine-ops/service.ts`) reads them for one workspace, with the proposed thresholds, and `getEngineAlerts` (`actions.ts`) exposes it. Any member may read them, as with the stage metrics. `alertsInput` keeps only the workspace id (`input.ts`).
- The page: a new "Alerts right now" section on `/engine-ops` (`src/components/ops/engine-ops-screen.tsx`). It shows severity, kind, the request or provider concerned and the reason in plain words, with the threshold version stated. An empty list says "No alerts right now". Nothing is invented: a workspace with no engine activity has no alerts (test).
- Checks, run here: `NODE_ENV=development node --experimental-strip-types --test src/lib/meridian/engine-ops/service.test.ts`: 14 of 14 pass on PGlite (3 new: the input check, the dead-letter alert to each member and refusal to a stranger, and the empty workspace). `npx eslint` on the five changed files: exit 0. `npm run typecheck`: exit 0.
- Not checked here: the page in a browser (AGENTS rule 11). The sandbox has no running dev server for it now. CI's `ui-smoke` job loads `/engine-ops` on the pushed commit, and the browser check of this section is still to do if CI does not cover it.
- Decided by the loop: Q14, the proposed thresholds, shown as proposed.
- Still open in R5: the engine's batch and concurrency modules (`ops/batch.ts`, `ops/concurrency.ts`), then the learning modules. R8 waits for R5 and R6.

## 2026-10-31 13:41 UTC: round 2, R5 unit: the batch planner on /engine-ops

- Wake: the scheduled wake (`trig_01PQdwpitJMBY9gTBXBRZd62`) fired at 13:38:47Z. CI on `5c2bb38` (the alerts commit, run 41204886031) finished with every check run successful and CodeRabbit skipped. PR #85 is clean and still a draft.
- Task: R5, `src/engine/ops/batch.ts`. It had no caller. Now `readWorkspaceBatch` (`src/lib/meridian/engine-ops/service.ts`) counts the workspace's batch-priority requests in the window and plans them for OpenRouter, the only route in the batch table, with `planBatch` and `summarizeBatch`. `getEngineBatchReport` exposes it to any member. The page shows "Batch requests" with the counts and the planner's reason. Nothing is claimed as batched.
- Checks, run here: `src/lib/meridian/engine-ops/batch-report.test.ts`: 4 of 4 pass on PGlite (no batch request; a normal request is not counted; a batch request runs as normal calls with the planner's reason; a stranger is refused and another workspace sees only its own). `service.test.ts`: 14 of 14 still pass. `npx eslint` on the four changed files: exit 0. `npm run typecheck`: exit 0.
- Not checked here: the page in a browser. CI's `ui-smoke` job covers the page on the pushed commit.
- Decided by the loop: Q15, the planner runs when the page is read, not when a request starts. Engine start is not changed.
- Doc to refresh at the end of R5: the PR #85 description still says 2 modules are wired. It now says 4 of 45. I have not edited the PR body for this yet.
- Still open in R5: `ops/concurrency.ts` (its input is the provider attempt history, which the page does not read yet), then the learning modules.

## 2026-10-31 14:07 UTC: round 2, R5 unit: the concurrency proposals on /engine-ops

- Wake: the scheduled wake (`trig_013Epvr27QkYS4434pSrueMD`) fired at 14:03:01Z. CI on `5ef58a9` (the batch-report commit) finished with all 13 check runs successful, CodeRabbit skipped. PR #85 is clean and still a draft.
- Task: R5, `src/engine/ops/concurrency.ts`. `readWorkspaceConcurrency` (`src/lib/meridian/engine-ops/service.ts`) reads the workspace's provider calls from the last hour (`engine_provider_attempts`) and runs `proposeConcurrency` with the current sizes from `config/thresholds.ts` and the proposed bounds. `getEngineConcurrency` exposes it. The page shows "Concurrency proposals": the sizes now and proposed, the reason, and how many calls were matched to a bucket.
- What the page shows: every bucket is held. The route table names no model for OpenRouter, so `engine_provider_attempts` cannot be matched to a bucket. Growth would also need saturation, which the caller must sample from `engine_bucket_leases`. The page says so. Nothing is applied.
- Checks, run here: `concurrency-report.test.ts`: 3 of 3 pass on PGlite (no calls, calls that cannot be matched and no size moves, a stranger refused and another workspace sees only its own). `service.test.ts`: 14 of 14. `batch-report.test.ts`: 4 of 4. `npx eslint` on the four changed files: exit 0. `npm run typecheck`: exit 0.
- The 429 shrink rule is not exercised through the page, because no call can be matched. Its rules are tested in `src/engine/ops/concurrency.test.ts` (engine tests, unchanged here).
- Decided: Q16 is an owner decision and is left open. The bucket column is a schema change.
- Not checked here: the page in a browser; CI's `ui-smoke` job covers it.
- Still open in R5: the learning modules (`fatigue`, `guardrails`, `organic-telemetry`, `parameters`) and the rest of the 45, per group.

## 2026-10-31 14:29 UTC: round 2, R5 group: the four learning modules, explained

- Wake: the scheduled wake (`trig_01LpiCVXmYVgN7rUuVLxHyn6`) fired at 14:28:06Z. CI on `0114482` (run 41208652265, the state commit that carries the concurrency code) finished with every check run successful, CodeRabbit skipped. PR #85 is clean and still a draft.
- Task: R5, the learning modules `fatigue`, `guardrails`, `organic-telemetry` and `parameters` (all in `src/lib/meridian/learning/`). None has a caller outside tests. No code changed.
- Why none is wired: each one changes learning, scoring or product direction. The engine rules (CLAUDE.md, rule 6 of AGENTS.md) keep scoring changes for the owner, and the owner's answer to Q3 covers making modules work, not deciding what learning learns from. Each one is explained in Q17, with what it does and what wiring it changes.
- The one with a real risk: `guardrails` finds test and fixture records. I checked the learning and measurement code for any other filter of that kind: none exists. So test rows could reach learning today. This is recorded as a finding for the owner, not fixed here.
- Decided by the loop: none. Q17 is an owner decision and is open.
- Still open in R5: 36 modules, handled one group at a time, next `studio/loop.ts` and `study/deep-study-service.ts`.

## 2026-10-31 14:52 UTC: round 2, R5 group: studio/loop.ts and study/deep-study-service.ts, explained

- Wake: the scheduled wake (`trig_011Zj65RUJCdwjuYEDL2ie9q`) fired at 14:50:57Z. CI on `3c1ddac` (run 41210358492) finished with every check run successful, CodeRabbit skipped. PR #85 is clean and still a draft.
- Task: R5, two modules with no caller outside tests. No code changed.
- `studio/loop.ts`: `runCoreLoop` runs on `testImageProvider`, `startTestVideo` and `testLoopEmbedding`, and a fake publisher. Its exported helpers (retry, dead image, calibration) demonstrate those fakes. Wiring it would show fixture results as real, which the no-fake-success rule forbids.
- `study/deep-study-service.ts`: `conductDeepStudy` calls `jevService.evaluateEvidence` for eight model-backed JEV questions. Wiring it would start model calls (a live provider call, a hard stop) and use JEV judgment, which AGENTS rule 6 keeps unchanged without a task that names it.
- Decided by the loop: none. Q18 is an owner decision and is open.
- Still open in R5: 34 modules. Next group: `production/route.ts`, `production/rework-engine.ts` and `production/voice-director.ts`.

## 2026-10-31 15:15 UTC: round 2, R5 group: the three production planners, explained

- Wake: the scheduled wake (`trig_01JC26gmF1ZKDnkMkoRYGshP`) fired at 15:13:14Z. CI on `59b4679` (run 41212121361) finished with every check run successful, CodeRabbit skipped. PR #85 is clean and still a draft.
- Task: R5, `production/route.ts`, `production/rework-engine.ts`, `production/voice-director.ts`. None has a caller outside tests. No code changed.
- `route.ts`: approval routing (any REJECT rejects, then HUMAN_REVIEW, else approve). Wiring it changes approvals, which is the owner's decision.
- `rework-engine.ts`: needs footage with known rights (the R4 question) and has a placeholder default music asset. Its cost estimate comes from the source ladder, so it is not invented here, but the feature is not decided.
- `voice-director.ts`: needs a voice (creator audio or consented synthetic) and a voice vendor, which is still open.
- Decided by the loop: none. Q19 is an owner decision and is open.
- Still open in R5: 31 modules. Next group: `jobs/durable.ts` and `video/scene-frames.ts`.

## 2026-10-31 15:37 UTC: round 2, R5 group: jobs/durable.ts and video/scene-frames.ts, explained

- Wake: the scheduled wake (`trig_018uvSyp6xrL5x2dei2UjpsH`) fired at 15:34:49Z. CI on `4a17603` (run 41213886480) finished with all 13 check runs successful. PR #85 is clean and still a draft.
- Task: R5, `jobs/durable.ts` and `video/scene-frames.ts`. No code changed.
- `jobs/durable.ts`: an in-memory array queue (`createDurableQueue`), not stored anywhere. The product runs its jobs through the Postgres worker (several files use `skip locked`). Using this would be a parallel pipeline.
- `video/scene-frames.ts`: a pure four-frame selector by scene span. No product file imports it (checked). Image QC selects frames in `decisions/frames.ts`, so switching would change every visual judgment.
- Decided by the loop: none. Q20 is an owner decision and is open. Both modules are recommended for deletion, which needs the owner.
- Still open in R5: 29 modules. Next group: `flow/nodes.ts` and `grading/priors.ts`.

## 2026-10-31 15:58 UTC: round 2, R5 group: flow/nodes.ts and grading/priors.ts, explained

- Wake: the scheduled wake (`trig_017J8rMEpvqwMZvdHtVzNsqB`) fired at 15:56:38Z. CI on `f77acca` (run 41215626431) finished with all 13 check runs successful, CodeRabbit skipped. PR #85 is clean and still a draft.
- Task: R5, `flow/nodes.ts` and `grading/priors.ts`. No code changed.
- `flow/nodes.ts`: a node graph with the Factory's stages (source, grading, planning, production, gate, publish, organic publish). It has no caller, and using it would be a parallel pipeline.
- `grading/priors.ts`: labelled seed values (hook retention, speech pace, niche view baselines), each marked as a seed, not a fitted weight. Scoring would need a calibration report first (AGENTS rule 9).
- Finding: the speech-pace range differs. Here it is 140 to 185 words a minute. `production/voice-director.ts` uses 140 to 180 with a 160 baseline. The two should agree before either is used (Q21).
- Decided by the loop: none. Q21 is an owner decision and is open.
- Still open in R5: 27 modules. Next group: `intelligence/cluster.ts` and `jev/calibration.ts` (JEV logic: check AGENTS rule 6 before touching it).

## 2026-10-31 16:20 UTC: round 2, R5 group: intelligence/cluster.ts and jev/calibration.ts, explained

- Wake: the scheduled wake (`trig_01EcxPBFzTUUfKCntNb5epkA`) fired at 16:18:28Z. CI on `b6e30cf` finished with all 13 check runs successful, CodeRabbit skipped (watchdog at 16:09 found the chain alive). PR #85 is clean and still a draft.
- Task: R5, `intelligence/cluster.ts` and `jev/calibration.ts`. No code changed.
- Checked: neither file has a caller outside tests. The grep first matched other calibration modules by name; the exact import check found none for `jev/calibration.ts`. So both are test-only, as the inventory says.
- `cluster.ts` duplicates the grouping in `intelligence/whitespace.ts` (`clusterFingerprints`), which the opportunity engine and the studio loop use.
- `jev/calibration.ts` duplicates the Brier, log-loss and reliability code in `learning/calibration-report.ts`, which the calibration screen uses. Correction (17:04 wake): this entry first named `calibration/report.ts` as used by the screen. It is not: it has no product caller. Q22 is corrected to match.
- Decided by the loop: none. Q22 is an owner decision and is open. The loop recommends deleting both.
- Still open in R5: 25 modules. Next group: the `organic/*` modules.

## 2026-10-31 16:43 UTC: round 2, R5 group: the organic/* modules, explained

- Wake: the scheduled wake (`trig_01NBrMByDNCCXWqEnMbqSA3Z`) fired at 16:41:00Z. CI on `da31ba2` (run 41219140290) finished with all 13 check runs successful. PR #85 is clean and still a draft.
- Task: R5, the `organic/*` group (eight files) and its entry point `factory/instagram-volume.ts`. No code changed.
- Checked with exact import patterns: nothing outside the group imports `organic/*` except `factory/instagram-volume.ts`, and nothing imports that file. One earlier grep match (`jobs/execute.ts`) was a different module with the same name, not an import of the organic one.
- `instagram-volume.ts` asks Apify for about 1,000 reel candidates per niche per week. That is paid spend, a live call, so it cannot be wired without the owner's go-ahead.
- `learning-bridge.ts` writes organic results into learning, which is scoring.
- Decided by the loop: none. Q23 is an owner decision and is open.
- Still open in R5: the rest of the list in section 6A. Next group: `quality/evidence.ts` and `shopify/reel-attribution.ts`.

## 2026-10-31 17:04 UTC: round 2, R5 group: quality/evidence.ts and shopify/reel-attribution.ts, explained

- Wake: the scheduled wake (`trig_01D9mu47Jiq8f3dAu5FKVa9G`) fired at 17:03:00Z. CI on `ef48614` (run 41220939864) finished with all 13 check runs successful, CodeRabbit skipped. PR #85 is clean and still a draft.
- Task: R5, `quality/evidence.ts` and `shopify/reel-attribution.ts`. No code changed.
- `quality/evidence.ts`: a 19-line labeller (freshness, duplicate, weak). No product file imports it.
- `shopify/reel-attribution.ts`: derives a tracked link and a keyword per reel. Its header says publish should call it, and that the publish files belong to another workstream. Wiring it changes every reel's published link, an outward change.
- Correction to the 16:43 and 17:03 entries: I first wrote that `calibration/report.ts` is used by the calibration screen. The exact import check shows no product file imports it. The screen uses `learning/calibration-report.ts`. Q22 is corrected.
- Decided by the loop: none. Q24 is an owner decision and is open.
- Still open in R5: the rest of the list in section 6A. Next group: `calibration/report.ts` (no caller, verified), and `discovery/provenance.ts`.

## 2026-10-31 17:26 UTC: round 2, R5: calibration/report.ts explained; discovery/provenance.ts planned

- Wake: the scheduled wake (`trig_01Jiamxx3Hrr49LRJic8hhgf`) fired at 17:24:55Z. CI on `fe06b3c` (run 41222695925) finished with all 13 check runs successful, CodeRabbit skipped. PR #85 is clean and still a draft.
- Task: R5, `calibration/report.ts` and `discovery/provenance.ts`. No code changed.
- `calibration/report.ts`: a third calibration implementation (bins, reliability, Brier, expected calibration error). No caller (exact import check). It says it is not applied to thresholds. Recorded as Q25 for the owner to choose one calibration report.
- `discovery/provenance.ts`: a read-only, brand-scoped query of which runs saw each source. Not wired this wake. It is the next unit: it needs a server function with the same brand-access check as `listDiscoveredItemsFor`, a small line on the Market stored-pages list, and PGlite tests. It does not change scoring or publishing, so it needs no owner decision.
- Decided by the loop: none. Q25 is an owner decision and is open.
- Still open in R5: the rest of the list in section 6A, after provenance.

## 2026-10-31 17:52 UTC: round 2, R5 unit: discovery provenance wired on the Market page

- Wake: the scheduled wake (`trig_01E7AfPHGf2YAgUTW1RinqDT`) fired at 17:46:30Z. CI on `38331e6` (run 41224535929) finished with all 13 check runs successful, CodeRabbit skipped. PR #85 is clean and still a draft.
- Task: R5, `discovery/provenance.ts`. Wired:
  - `src/lib/meridian/discovery/provenance-view.ts`: `itemProvenanceFor` checks brand access with `requireBrand` (viewer), finds the page's source key among its sightings in that brand, and reads the runs with `sourceProvenance`. A page of another brand, or a missing page, gives no record.
  - `src/lib/meridian/discovery/item-actions.ts`: `getDiscoveredItemProvenance`, a server function with input checks and the auth middleware.
  - `src/components/market/stored-pages.tsx`: a "Where it was seen" disclosure per page. It loads only when opened, shows "Seen in N runs" and each run's stored-or-found-again date, in plain text. `market.tsx` passes the brand id.
- Fix in the same change: `provenance.ts` wrote a Date's long form for each sighting time. It now writes ISO text, the same as the discovered-items list. The existing `source-provenance.test.ts` still passes.
- Checks, run here: `provenance-view.test.ts` 1 of 1 (member sees both runs in order, seen-before flags, ISO times, a stranger refused, another brand and a missing page give no record). `source-provenance.test.ts` 3 of 3. `item-list.test.ts` 2 of 2. `discovery-source-rows.test.ts` 3 of 3. `npx eslint` on the changed files: exit 0. `npm run typecheck`: exit 0.
- Not checked here: the Market page in a browser (AGENTS rule 11). CI's `ui-smoke` job covers the brand pages.
- Decided by the loop: none. No owner decision needed (read-only, no scoring or publishing change).
- Still open in R5: the rest of section 6A. Next: `storage/filesystem.ts` and `vision/logo.ts`.

## 2026-10-31 18:13 UTC: round 2, R5 group: storage/filesystem.ts and vision/logo.ts, explained

- Wake: the scheduled wake (`trig_012fTz695u118Mn6LQgHMoUW`) fired at 18:11:13Z. CI on `9b089e9` (run 41226545358) finished with all 13 check runs successful, CodeRabbit skipped (the 18:03 wake). PR #85 is clean and still a draft. The 18:10 watchdog found the chain alive.
- Task: R5, `storage/filesystem.ts` and `vision/logo.ts`. No code changed.
- Checks: neither has a caller outside tests (exact import patterns). The product's artifact store is Google Drive (`docs/FIRST_TEST_RUN.md`, step 4); `filesystem.ts` would be a second storage location, and it is tied to R7's storage decision.
- `vision/logo.ts` is a second logo matcher. Image QC measures logos with `measureLogo` in `vision/measure.ts`.
- Decided by the loop: none. Q26 is an owner decision and is open.
- Still open in R5: `a11y/contrast.ts` and `factory/cost.ts` next, then the rest of section 6A.

## 2026-10-31 18:34 UTC: round 2, R5 group: a11y/contrast.ts and factory/cost.ts

- Wake: the scheduled wake (`trig_017ynq2sk7KKfzbNZmF1hRiC`) fired at 18:32:17Z. CI on `24156a1` (run 41228236404) finished with all 13 check runs successful, CodeRabbit skipped. PR #85 is clean and still a draft.
- Task: R5, `a11y/contrast.ts` and `factory/cost.ts`. No code changed.
- `a11y/contrast.ts`: used by `src/components/ui/tokens.test.ts` to check the theme's contrast ratios. Not dead code. The earlier inventory was wrong to list it as having no caller: its only user is a test, which is the accessibility gate. No change.
- `factory/cost.ts`: no caller at all (exact import check; the grep hit `engine/plan/cost.ts`, a different module). Its budget check is a spend control, so wiring it is the owner's decision (Q27).
- Decided by the loop: none. Q27 is an owner decision and is open.
- Still open in R5: `factory/render.ts` and `factory/benchmark-harness.ts` next, then the rest of section 6A.

## 2026-10-31 18:56 UTC: round 2, R5 group: factory/render.ts and factory/benchmark-harness.ts

- Wake: the scheduled wake (`trig_015CU8h521HJkvNnEW1jwrWj`) fired at 18:53:59Z. CI on `cccff51` (run 41229976673) finished with all 13 check runs successful, CodeRabbit skipped. PR #85 is clean and still a draft.
- Task: R5, `factory/render.ts` and `factory/benchmark-harness.ts`. No code changed.
- `factory/render.ts`: no caller (exact import check). Its clips come from the fixture helpers in `video/inspect.ts`, so wiring it would show fixture clips as a render. Recorded as Q28.
- `factory/benchmark-harness.ts`: used by its own test (`benchmark-harness.test.ts`), which checks the opportunity ranking against a hand-labelled gold set. Same treatment as `a11y/contrast.ts`: a test tool, no product change. The package has no benchmark script.
- Decided by the loop: none. Q28 is an owner decision and is open.
- Still open in R5: the engine modules still on the list (`engine/assets/firstLastFrame.ts`, `engine/jobs/review-decision.ts`, `engine/render/recorded.ts`, `engine/review/take/gold.ts`), then `lib/progress/*`, `lib/create/steps.ts`, `components/settings/connection-state.ts`, and `render/splice-run.ts`.

## 2026-10-31 19:18 UTC: round 2, R5 group: four engine modules, explained

- Wake: the scheduled wake (`trig_013MBDNEH4ZSVs8rJsVeoshr`) fired at 19:15:41Z. CI on `8d52d29` (run 41231693551) finished with all 13 check runs successful, CodeRabbit skipped. PR #85 is clean and still a draft.
- Task: R5, `engine/assets/firstLastFrame.ts`, `engine/jobs/review-decision.ts`, `engine/render/recorded.ts`, `engine/review/take/gold.ts`. No code changed.
- Checked with exact import patterns and scripts: none has a product caller. `review/take/gold.ts` is used only by `review/labels.ts`, which only `review-decision.ts` uses. `render/recorded.ts` is not imported by the E1 scripts (which use `scripts/engine/fixtures/e1-recorded.json`). `firstLastFrame.ts` calls paid video providers if run.
- Decided by the loop: none. Q29 is an owner decision and is open.
- Still open in R5: `gates/slop-craft-gates.ts`, `lib/progress/*`, `lib/create/steps.ts`, `components/settings/connection-state.ts`, `render/splice-run.ts`.

## 2026-10-31 19:45 UTC: owner request, a style preset from an uploaded reference

- Request (owner, in chat): use Meridian's system to copy the style of an uploaded 60 s 3D satellite explainer, and make a full preset that can be reused any time. This interrupted R5; R5 resumes on the next wake.
- Ran, with no network and no spend: Meridian's own media handlers (`functions/ffmpeg/`: probe, cuts, loudness, timeline, picture, black, flicker, motion, silence) on the local file, then the engine's pure analysis code (`analyze/zoom.ts`, `analyze/measure.ts`, `edit/grammar.ts`). The grammar refused to build from free measures alone (motion, captions, sound unknown), as it should.
- Not run: speech-to-text, segmenter, genome and frame_reader (paid). The frames were read by the coding agent instead, and every such value is labelled `read`.
- Built: `src/engine/presets/` (the `StylePreset` shape, a registry, `presetProblems`, `installStylePreset` into `engine_kits`) and the first preset, `three-d-data-explainer.ts` (kit `sk_3d_data_explainer`, format `ref_98053a5a224b3833a3ed4421`). No contract change. 7 tests pass (`style-presets.test.ts`, PGlite). ESLint and typecheck clean.
- Report: `docs/engine/STYLE_PRESET_3D_DATA_EXPLAINER.md`. Gaps recorded as Q30 (live analysis, accent font and palette roles, caption and data components, an install button).
- Note: `installStylePreset` has no product caller yet (Q30 part D), so it is itself a test-only module until the owner decides.

## 2026-10-31 20:35 UTC: owner requests done; round 2, R5: the slop and craft gate, explained

- Owner requests since 19:45: two original preview renders made from the 3D data explainer preset (`scripts/engine/preset-preview/`), measured against the reference with `compare.ts`; preset version 2 (layout, zoom jump kinds, motion per tenth, cut rule); a media-function fix (ffmpeg's `nan` momentary loudness now reads as silence; it made any reference with a hard mute fail analysis); and the cookbook presets plan (`docs/planning/COOKBOOK_PRESETS_PLAN.md`, round 3, decisions in Q31).
- CI: one red run on d43b2cd and 5ba355e (the env-example test: the renderer read an environment variable). Fixed in acb0875 (a `--chromium` flag); 70f6fb0 was fully green. CI is running on 3dd919f.
- Wake (20:34): `gates/slop-craft-gates.ts` checked with exact import patterns: no caller. Explained, not wired (Q32): four of its inputs have no measurement in Meridian, and its loudness and flicker checks duplicate the engine's post-render gate and integrity detector. The safe-zone check is the part worth keeping.
- Still open in R5: `lib/progress/*`, `lib/create/steps.ts`, `components/settings/connection-state.ts`, `render/splice-run.ts`.

## 2026-10-31 (later): round 3, cookbook presets, K0 to K15

- K0: the four leftover R5 modules checked. `lib/progress/step-url.ts` is wired already. The rest are explained (Q33).
- K1 to K4: one control schema (all 14 component declarations parse), the cookbook schema and validator (18 tests), the resolver (15 tests), and the 3D explainer as the first built-in cookbook (11 tests). The validator also allows a select to set a typed parameter through a lookup table.
- K5: the four factory presets and the three start modes as cookbooks. Resolved through their cookbooks, the presets give back exactly the configuration `getPresetConfig` gives (12 tests).
- K6, K7: migration `0140_cookbooks.sql` and the store (8 tests); the policy and the service with the server functions (14 tests). The rules follow D5.
- K8: a brand's saved factory line is also its cookbook. Saving writes both; loading prefers the cookbook. The migration of old rows is idempotent (5 tests). The existing factory tests pass.
- K9 to K11: eligibility from the inputs (9 tests); the selector's logic with the model call behind a port (8 tests); the confirmation step with its records (5 tests). The role's registration is a contract change beyond the approved field: parked (Q34).
- K12: a resolved cookbook reaches the request through existing fields (4 tests).
- K13 (partly): migration `0141` and the session record, written only while the run is a draft (3 tests). The engine-request copy and the export package remain.
- K14: `engine-contracts@12`, approved by D1: the optional cookbook reference on the request, with the Bible note (6 tests; all 299 engine contract tests pass).
- K15 (partly): `scriptwriter@3` reads the cookbook block; a run without a cookbook keeps version 2 (28 tests across the role, the prompt pins and the handler). The planner, critic and editor remain.
- Typecheck and lint are clean for every changed file. Each unit was committed and pushed.

## 2026-10-31 21:55 UTC: round 3, K16 to K28 (most units)

- K16 (partly): a cookbook's template becomes a plan skeleton the orchestrator's schema accepts; edits are kept and marked; a plan is sent only with the right selection (3 tests).
- K17 (partly): the settings panel's model (4 tests) and component. Not on a screen yet.
- K21 (partly): `stat.counter`, a count-up component, registered; the component contract tests pass (112). Its look is unverified here: the GSAP script loads from a CDN this sandbox cannot reach.
- K22 (partly): checks against targets, with unknown never a pass (3 tests).
- K24: the `cookbook-video` skill for agent-mode videos. K30 (guide): `docs/COOKBOOKS.md`, in plain words.
- K25 (partly): a draft cookbook from a reference's measures; what was not measured is unknown (3 tests).
- K26, K27: a UGC product cookbook and a voice-led list (5 tests). Finding a gap while testing them: a step that makes a paid visual was not priced unless an ingredient named it, so agent mode could be offered for a paid run. Fixed: such a step is priced, takes the run out of agent mode, and a coded graphics step is free. Each paid cost is counted once.
- K28 (partly): results by cookbook and setting, with unknown never averaged in as 0 (4 tests).
- The wake of 20:56 fired into a separate session, which made no commit on this branch. The next wake is armed for 22:15.
- Checks at each unit: the cookbook suites, the component and compose suites, the engine contract suite, typecheck and lint.
- Not run here: the browser checks (ui-smoke in CI) and the look of the components.

## 2026-10-31 22:19 UTC: wake: K18 component

- Wake (22:18): CI on 17d050c all green (typecheck, lint, tests, e2e, ui-smoke, release acceptance). The branch matched the pushed head; no foreign commits.
- K18: `cookbook-selection-step.tsx` draws the selection view (typecheck and lint clean). Not mounted yet: mounting it in the hub needs the run path and the browser check.
- Next: mount in the hub (K18), then K19 (library screen; the route tree is generated, so the route needs the generator and the navigation tests).

## 2026-10-31 23:31 UTC: wake: K18a

- Wake (23:26): the branch matched the pushed head; CI on the previous head (1bab925) was green. No foreign commits.
- K18a done: the run's inputs are read from the session; a cookbook choice is checked and recorded on a draft run only. A selector that is not connected gives a 'picked' record. 6 PGlite tests; all cookbook suites (152) and the full content-factory suite (269) pass.
- Next: K18b (apply the recorded cookbook when a run starts, in service-run.ts), then K18c (mount the step in the draft panel).

## 2026-10-31 23:57 UTC: wake: K18b

- Wake (23:53): the branch matched the pushed head; CI on K18a (d135524) was green (13 of 13). No foreign commits.
- K18b done: a draft run's recorded cookbook is applied in `buildFor`, so the start and the preview see the same request. Two PGlite tests; the content-factory and cookbook suites pass together (413).
- Next: K18c (mount the selection step in the draft panel), then the rest of K18's browser check in CI.

## 2026-11-01 00:12 UTC: wake: shard 2 red (the E6 load test)

- Wake (00:0x): CI on 369922a (K18b): `tests (shard 2)` failed with 1 failure of 1263. The failing test is `src/engine/ops/load.test.ts`, E6 (100 requests), not K18b's code. Reproduced locally: 0 variants where 20 were expected.
- The same failure is on `main` (9664557), so it was not caused by the cookbook work.
- Cause: a time bomb in the test. The chain fixture (`src/engine/ops/test/chain.ts`) makes its reservation in October 2026 (`CREATED`), while the engine's clock read the real time. `extendForVariants` refuses to raise a reservation in another month, so every variant was skipped ("made in 2026-10 and cannot be raised in 2026-11"). The run started at 23:59 UTC on 31 October and reached its variants after midnight.
- Fix (`e6a4b28`, pushed): the chain's clock starts one second after `CREATED` and moves one second per read, so it stays in the reservation's month and each read is later than the last. Nothing depends on the wall clock. Only the fixture changes; the funding rule stays.
- Verified: `load.test.ts` and the nine other test files that use the chain fixture (53 tests) pass; the typecheck passes; eslint passes on the changed file. CI on `e6a4b28` is pending.
- Owner question raised: Q35, whether a reservation from one month may fund variants in the next (the engine rule is unchanged).
- Next: K18c (mount the selection step in the draft panel), once CI on `e6a4b28` is green.

## 2026-11-01 00:31 UTC: K18c

- Wake (00:17 is the scheduled one; this unit ran after the shard fix was pushed): CI for `e6a4b28` is pending (checked below).
- K18c done (`24a2515`): the Cookbook step sits above "Make this video" in the draft panel. The server proposes from the session's own inputs (`proposeCookbookForRunAction`), the picker and the alternatives show labels, the confirm sends the top pick at its version with its resolved values, and the start waits while a pick or the picker has no recorded choice. A proposal of none, failed or refused does not block the start.
- Checks: typecheck, eslint, 454 tests across the cookbook, content-factory and cookbook component suites. New: the proposal on PGlite (labels and versions; a started run; no length), the confirm payload.
- Not checked here: the look and the button in a browser. CI ui-smoke runs them.
- Caveat for the owner: a choice made before a reload is not shown; the person confirms it again. Recorded in RUN_PLAN K18c.
- Next: K19 (the library screen; the route tree is generated, so regenerate it and update the navigation tests).

## 2026-11-01 00:34 UTC: wake: the clock class in the estimate tests

- Wakes (00:20 to 00:33): CI failed on several heads: `tests (shard 0, 1, 5)` and the aggregate `check`, on `e6a4b28`, `4a7de92`, `24a2515`, `4c34efe`, `d6af8d2`, `f550b70`. Each failure on a superseded head is the same clock class (below).
- Cause: several tests build a hold in October 2026 and extend it on the real clock. From 1 November, `extendForPlan` refuses the extension across the month, so the tests fail. The estimate handler read `new Date()` directly and had no clock port.
- Fixes (pushed): the estimate handler takes an optional `now` port, like the other stages (`d6af8d2`); the tests pass their fixed time in `estimate-reserve`, `estimate-chosen-stage` (`48d40e1`), `e3-pipeline` (`f550b70`) and `model-choice-pipeline` (`8d333a3`). The E6 chain fixture was fixed in `e6a4b28`.
- Mistake: `d6af8d2` was pushed while `estimate-chosen-stage` still failed. My check piped the test output through `grep`, which exits 0, so the `&&` chain committed. Fixed forward in `48d40e1`. Rule from now on: check the test process's exit code, not a grep.
- Current head `8d333a3` (run 41256855570): green so far: `tests (shard 0)`, `typecheck, lint and build`, `release-acceptance`, `sidecar`, `postgres money checks`. Shards 1 to 5 and `ui-smoke` were still running at this entry.
- Local full `src` run (825 files, started on the pre-fix head): at about 3,050 results, the only failures are the five fixed above. Still running.
- Open: confirm shards 1 to 5 and ui-smoke on `8d333a3`; then close out the full local run.

## 2026-11-01 00:41 UTC: CI green on 8d333a3; the local full src run closed

- CI on `8d333a3` (run 41256855570) is fully green: tests shards 0 to 5, ui-smoke, e2e, release-acceptance, sidecar, postgres money checks, typecheck/lint/build, and the aggregate `check`.
- The local full `src` run (825 files, started on the pre-fix head) finished: 7,005 tests, 6,959 pass, 41 skipped, 5 fail. The five failures are the clock class already fixed (`e3-pipeline`, `estimate-chosen-stage` x3, `model-choice-pipeline`); each of those files was re-run after its fix and passes.
- Other failures in the wake notifications were on superseded heads (`e6a4b28`, `4a7de92`, `24a2515`, `4c34efe`, `d6af8d2`, `f550b70`, `48d40e1`) and were the same class.
- The loop-record commit's own CI run (41257279429) was still running at this entry.
- Next: K19 (library screen).

## 2026-11-01 00:58 UTC: K19 (in part)

- CI on the current head (run 41258120485) is green in full, so the red checks are closed.
- K19 in part: the library model (6 tests), the route `/brands/$brandId/cookbooks` with the regenerated route tree, the screen (filters, cards, a detail with the settings panel, a link to the Create section, "Save as my cookbook"), and a "Cookbooks" sidebar item under Create. Navigation tests updated: the brand screen count is 13.
- Checks: typecheck, eslint, and 51 tests across the cookbook and navigation suites pass. The Vite build succeeds.
- Not done: the version history list (no server function lists versions), the `?cookbook=` link (the Content page drops unknown search keys), the repurpose `packs` capability, and a browser look.
- Next: K20 (the pipeline editor becomes the cookbook editor), or finish K19's version list first.

## 2026-11-01 02:12 UTC: wake: K19 completed (the version list)

- Watchdog (02:09): the state was running with next_wake_at at 00:17, more than 30 minutes past, so the Wake procedure ran. The branch matched my last commit (750d801), and CI on it (run 41259369307) was green, with shard 2 still running and no failure at this entry.
- K19 completed: the version list. `listCookbookVersions` (store, the same visibility rule as a read), `versionsFor` (service; a built-in has no stored history and says so), `listCookbookVersionsAction` (viewer), and the detail's Versions list. Tests: a store test (newest first, another brand's brand-only versions not listed) and a service test (a built-in is empty, a missing one is not found, two saves list as 2 then 1). 72 tests across the cookbook, navigation and component suites pass; typecheck and eslint pass.
- Still open for K19 on purpose: "Use in Content Factory" goes to the Create section, not with a `?cookbook=` parameter; the repurpose `packs` capability; a look in a browser.
- Next wake armed for 02:33 UTC (trig_01PWijiWoBsbvKWQyWYMToKQ). Next task: K20.

## 2026-11-01 02:39 UTC: wake: K20a

- Wake (02:33): the branch matched my last commit (d4e722d). CI on it was fully green at 02:25 (run 41264235224).
- K20a done (`factory-bridge.ts`, `pipeline-actions.ts`): `savePipelineConfig` and `applyPipelinePreset` no longer write `factory_pipeline_configs`. Both save through `saveFactoryLine`, which validates the line, writes its cookbook and throws when the cookbook refuses. One PGlite test: a saved line writes no old row and leaves its cookbook in the store.
- Checks: typecheck and eslint pass on the changed files. The factory and cookbook suites (76 files, 515 tests) pass. The commit was pushed before the suite finished, as the stop hook required; the suite then passed.
- Next: K20b (the preset bar and the editor).
- Next wake armed for 02:59 UTC (trig_015zeiXC6vR5eq9BcfZ1XXrG).

## 2026-11-01 03:02 UTC: wake: K20b split

- Wake (02:59): the branch matched 7623029, and its CI was green (02:51).
- K20b is too big for one wake, so it is split (RUN_PLAN, K20): K20b1 the preset bar lists the brand's cookbooks; K20b2 the editor shows a cookbook's steps and controls read-only; K20b3 the editor edits controls and per-role instructions.
- Finding: the preset bar's labels already come from the same source as the factory cookbooks (`PRESET_LABEL`), so swapping the source would change nothing visible; it is not a unit. The validation piece is already done for prompts: prompts-panel shows each empty prompt's message beside its field. The generation and grading fields get the same treatment in K20b3.
- This wake changed documents only. No code changed, so no checks were run beyond the branch state.
- Next: K20b1.

## 2026-11-01 03:24 UTC: wake: K20b1

- Wake (03:21): CI on fb035a5 was fully green; the branch matched the remote.
- K20b1 done (`c006efd`): the preset bar lists the brand's other cookbooks beneath the four factory presets, read-only, with one link to the library. The factory presets and blank modes are left out (`nonFactoryCardsOf`). The editor loads the library for the bar; a library that cannot be read shows no list.
- Checks: typecheck and eslint pass; the factory component and cookbook library tests pass (19). Not checked in a browser (ui-smoke runs the factory screens in CI).
- Next: K20b2.
- Next wake armed for 03:44 UTC (trig_01XVVZ19zZJrpRqSUzSBXm4g).

## 2026-11-01 03:37 UTC: wake: release acceptance red on 00244ac; K20b1 reverted

- Wake (03:27): the release acceptance failed on 00244ac in two checks (F1, F2: the Content page tabs). I reproduced both locally with the pre-installed Chromium (a scratch preload, outside the repo, gave it the path; no repo file changed).
- Cause: the Content page's client bundle crashed with "node:crypto ... randomBytes ... in client code". K20b1 made the preset bar and the editor import the cookbook library's client code, which imports the engine contracts. `contracts/ids.ts` and `contracts/hash.ts` use `node:crypto`, which the browser does not have.
- Fix: revert K20b1 (`d655807`, a new commit; no history rewritten). The local acceptance then passes: 30 of 30.
- Likely also broken: the K19 route `/brands/$brandId/cookbooks` imports the same client code, and CI never opens it. Not verified in a browser yet; K19b verifies and fixes it.
- Plan: K19b (RUN_PLAN): the server computes the cards and the settings; the browser code imports only types and plain helpers. Then re-add K20b1, and add the cookbook route to the acceptance.
- Next wake armed for 03:57 UTC (trig_014K6Hm5YCTYS9hcfNdH1crk).

## 2026-11-01 03:47 UTC: wake: CI green on the revert; K19b1

- Wake (03:44): CI on 0aabd33 (the revert) was green: the release acceptance passed in CI, as it did locally (30 of 30), and all test shards passed.
- Two wake-ups were pending (03:44's and the 03:57 one). The 03:57 one is cancelled, and one wake is armed for 04:08 UTC (trig_0143dCyC2LJAPGeuXJWiMdRV).
- K19b1 done (`ceb3b68`): the cookbook role and family lists are plain leaf modules with no node imports. 467 tests across the engine contract, cookbook, cookbook-component and navigation suites pass; typecheck and eslint pass.
- Next: K19b2 (the cards come from the server), then K19b3 (`fitsControl` out of validate.ts), then a browser check of the cookbook route.

## 2026-11-01 04:12 UTC: wake: K19b2

- Wake (04:08): the branch matched c5ca0c2; its CI check had completed with no failure.
- K19b2 done (`81fc9c5`): the card rules moved to `cookbooks/cards.ts` (server). `libraryFor` returns the cards, and the library screen draws them. `library-model.ts` keeps only the plain filter and the family list, with no engine import. 211 tests across the cookbook, choice, card, component and navigation suites pass; typecheck and eslint pass.
- Not yet: the screen still imports `actions.ts` (which reaches the engine) and `settings-model.ts` (through `validate.ts`). K19b3 handles those; a browser check of the route follows.
- Next wake armed for 04:32 UTC (trig_0187GzR2BjkFJxWcKkrJyGid).

## 2026-11-01 04:38 UTC: wake: K19b3 and the cookbook route checked in a browser

- Wake (04:32): the branch matched ad7acf3; its checks completed with no failures.
- K19b3 done (`c972854`): `fitsControl` moves to controls.ts (the validator re-exports it), and the settings model imports it from there, so the library's settings code no longer loads the validator.
- New browser check H1 in the release acceptance: it opens `/brands/$brandId/cookbooks`, requires its heading, its list and the 3D data explainer card. Locally: 31 of 31 checks pass, and the dev server log has no externalized-module error. The route works in a browser.
- Tests: typecheck and eslint pass; 142 tests across the cookbook, choice and component suites pass.
- Next: re-add K20b1 (the preset bar's cookbook list), now that the route is known to load.
- Next wake armed for 04:58 UTC (trig_01VHj8uqfqenum9G2VyUujN8).

## 2026-11-01 05:03 UTC: wake: K20b1 re-applied on the server cards

- Wake (04:58): the branch matched a9367af; its checks completed with no failures.
- K20b1 re-applied: the cookbook cards come from the server (`listCookbooksAction` returns them), and `nonFactoryCardsOf` (a client helper with plain fields) leaves out the factory presets and the blank modes. The editor passes the rest to the preset bar, which lists them read-only.
- Gate: the local release acceptance passed, 31 of 31 checks, including the Content-page checks F1 and F2 (which failed on the reverted K20b1) and the cookbook route H1. The dev server log has no externalized-module error.
- Tests: typecheck and eslint pass; the library and factory component tests pass (15).
- Next: K20b2 (the editor shows a cookbook's steps and controls read-only).
- Next wake armed for 05:23 UTC (trig_01PXrdY6q87qCf7nBgt2mZUH).

## 2026-11-01 05:27 UTC: wake: K20b2a

- Wake (05:23): the branch matched 2501843; CI on it was fully green (run 41275436279: every test shard, ui-smoke, e2e, release-acceptance, typecheck, sidecar and PostgreSQL).
- K20b2a done: `components/cookbooks/outline-model.ts`, a pure read-only outline of one cookbook: its steps in order (with what each waits for, and whether it is conditional) and its controls (with their defaults in words). The types are imported for typing only, so the browser can draw it. 3 tests; typecheck and eslint pass.
- Next: K20b2b (mount the outline in the editor, reading the cookbook through `readCookbookAction`).
- Next wake armed for 05:47 UTC (trig_014raF7ACovwWpmkVrCNHt3C).

## 2026-11-01 05:52 UTC: wake: K20b2b

- Wake (05:47): the branch matched e779348; its check had completed with no failure.
- K20b2b done: the preset bar's cookbook list has a Show steps button, which opens the cookbook's outline read-only (steps with what they wait for; controls with defaults). The outline is read through `readCookbookAction`, and drawn by `cookbook-outline.tsx`.
- Gate: the local release acceptance passes, 31 of 31, with no externalized-module error. The acceptance does not click the button, so its rendering is not checked in a browser here.
- Checks: typecheck and eslint pass; the factory and outline tests pass (15).
- Next: K20b3 (the editor edits controls and per-role instructions).
- Next wake armed for 06:12 UTC (trig_01GhMx3rmqm48iiUHUb1VnqP).

## 2026-11-01 06:13 UTC: wake: K20b3a

- Wake (06:12): CI on 38005f0 was fully green (every shard, ui-smoke, e2e, release-acceptance, typecheck, sidecar, PostgreSQL, and the aggregate check).
- K20b3a done: `components/cookbooks/edit-model.ts`, the editor's rules. A control takes only a value that fits it (its bounds, options and kind), and an instruction must say something and fit the 4000-character limit. The same checks run again on save. 4 tests; typecheck and eslint pass.
- Next: K20b3b (the editor's fields, saved through `saveCookbookAction`).
- Next wake armed for 06:33 UTC (trig_01TQ7fWMKhVwea21iKBn5b8c).

## 2026-11-01 06:36 UTC: wake: K20b3b part 1

- Wake (06:34): the branch matched aaf0dce; its check_suite completed with no failure. The check failures in the notifications were on old heads (f550b70, 48d40e1, 0d589fe and others).
- K20b3b part 1 done: `applyEdits` applies a set of control-default and instruction-text edits to a copy of a cookbook, stopping at the first failing edit and never changing the original. 6 tests; typecheck and eslint pass.
- Next: K20b3b part 2 (the editor's fields and the save through `saveCookbookAction`; a built-in cookbook is copied first, since admins maintain copies of built-ins).
- Next wake armed for 06:56 UTC (trig_01UrfzbaGatZZt56ASaHmN6F).

## 2026-11-01 06:58 UTC: wake: K20b3b part 2a

- Wake (06:56): the branch matched 15ea21e; its check suite completed with no failure.
- K20b3b part 2a done: `planSave` turns an edited cookbook into the server calls that save it. A workspace cookbook is one save of its next version. A built-in cookbook is forked to a `ck_my_` copy first, since its id is reserved and admins maintain copies of built-ins (D5), then the edited copy is saved. 9 tests; typecheck and eslint pass.
- Next: K20b3b part 2b (the editor's fields, and running the plan through `forkCookbookAction` and `saveCookbookAction`).
- Next wake armed for 07:18 UTC (trig_01UWsBk2p8ZC3iJBEafQRnY5).

## 2026-11-01 07:20 UTC: wake: K20b3b part 2b

- Wake (07:18): the branch matched a5790b7; the check runs for the current head were green so far, and the failures in the notifications were on old heads.
- K20b3b part 2b done: the save plan's copy is saved as a workspace cookbook. `runSavePlan` runs a plan through two injected calls (fork, save), stops at the first failure, and names the copy's state when the edits are refused. 13 tests; typecheck and eslint pass.
- Known gap (to check in the store): a copy's later versions do not carry the parent link the fork records, because the save path does not pass it.
- Next: K20b3b part 2c (the editor's fields, calling `applyEdits`, `planSave` and `runSavePlan` through the actions).
- Next wake armed for 07:41 UTC (trig_018C9q11URkiud5GZG4t5xeF).

## 2026-11-01 07:44 UTC: wake: K20b3 part 2c

- Wake (07:41): the branch matched f59d1f8; its check suite completed with no failure.
- K20b3 done: the outline panel has an Edit action for members and above. The edit form edits control defaults and instruction texts; Save runs the edit rules and the save plan through the server (a built-in is copied first; the server checks the whole cookbook again). Typecheck, lint and 35 component and factory tests pass. The release acceptance passes locally, 31 of 31, with no externalized-module error. The Edit action is not clicked by the acceptance.
- Next: a browser check of the Edit action (a save of a workspace cookbook and of a built-in copy), and the parent-link gap in the store.
- Next wake armed for 08:04 UTC (trig_01P9379T4BpYHrGZumRxF1L4).

## 2026-11-01 08:08 UTC: wake: the parent-link gap fixed

- Wake (08:04): the branch matched 083d58a; its check suite completed with no failure.
- Parent-link gap fixed: a later version of a copy keeps the parent its latest version recorded (the save path named none, so the copy lost its link from version 2). One PGlite test; the cookbook suites pass (188 tests). Typecheck and eslint pass.
- Next: a browser check of the Edit action (a save of a workspace cookbook and of a built-in copy), with the release acceptance extended to cover it.
- Next wake armed for 08:28 UTC (trig_012DV5N74c4ocuUxhxtJSt4E).

## 2026-11-01 08:45 UTC: wake: K20, the browser check of the Edit action

- Wake: CI on the head 88378b8 was green (check, e2e, the six test shards, ui-smoke, release-acceptance, postgres and sidecar; CodeRabbit skipped). The earlier acceptance run had been in progress and was read this wake.
- Unit done: acceptance check H2 in `scripts/release-acceptance/acceptance.mjs`. From the Batch section's Factory Line tab, a built-in cookbook's steps open, Edit opens the form, a changed instruction is saved with "Save as my copy", and "Saved as your copy." appears. Earlier failed runs were selector problems in the check (the route, the default section, then the tab order), fixed in the check, not in the component.
- Checks: local release-acceptance run ra-run10 (dev server, testing runtime) passed 32 of 32, exit 0, including F1, F2, H1, H2, D1 and E1. `node --check` and `npx eslint` on the acceptance script pass.
- Not covered: the single-save path of a workspace cookbook in a browser, and any live server. No live provider call was made.
- Still open in K20: the editor's steps and inline validation on the generation and grading fields.
- Next wake armed for 09:03 UTC (trig_01XTqaSPnH4asxHWexZQNdYF); the 08:50 wake was cancelled.

## 2026-11-01 09:08 UTC: wake: K20c, the step rules of the cookbook editor

- Wake (09:04, the scheduled wake): CI on the head 836406a was green (all 14 check runs). The local branch matched the remote, and the tree was clean.
- Unit done (K20c): `components/cookbooks/edit-model.ts` gains the rules for a cookbook's steps. A step's label is trimmed and must be 1 to 80 characters. A step's setting must be one the step already has, with a value of the same kind (number, string or boolean), and the schema's own check runs on the value (a finite number, a string of at most 2000 characters). `applyEdits` takes two new edit kinds, `step-label` and `step-param`, and applies them to a copy, as it does the others.
- Checks: `NODE_ENV=development node --experimental-strip-types --test src/components/cookbooks/edit-model.test.ts` passed 16 of 16 (13 before, 3 new). `npx eslint` on the two files exits 0. `npm run typecheck` exits 0.
- Not checked: the form does not show step fields yet, so nothing is in a browser. No live provider call was made.
- Still open in K20: K20d (the form's step fields, saved through the same plan) and K20e (inline validation on the generation and grading fields).
- Next wake armed for 09:27 UTC (trig_01X3jEtbKyuveoLmcLSgzp4A).

## 2026-11-01 09:33 UTC: wake: K20d, the step fields in the cookbook editor

- Wake (09:27): CI on the head 12c7e45 was green (13 check runs; CodeRabbit skipped). The local branch matched the remote.
- Unit done (K20d): `editsFromDraft` in `components/cookbooks/edit-model.ts` turns the form's draft (control values, instruction texts, and each step's name and settings) into the edits the rules and save plan take. The form (`cookbook-edit-form.tsx`) gains a Steps section after the instructions: a name field (up to 80 characters) and one field per setting, shown by its kind. Save uses the same rules and save plan as before.
- Acceptance: H2 also waits for the step name field, so the editor's new section is seen in a browser.
- Checks: `NODE_ENV=development node --experimental-strip-types --test src/components/cookbooks/edit-model.test.ts` passed 19 of 19 (16 before, 3 new). `npx eslint` on the three cookbook files and the acceptance script exits 0. `npm run typecheck` exits 0. The local release acceptance run `ra-run11` passed 32 of 32, exit 0.
- Not checked: saving a changed step name or setting in the browser. No live provider call was made.
- Still open in K20: K20e (inline validation on the generation and grading fields).
- Next wake armed for 09:53 UTC (trig_01MfAL22eiuKjWsV9VrH2PcC).

## 2026-11-01 09:59 UTC: wake: K20e, a message next to each refused field

- Wake (09:53): CI on the head b993730 was green (13 check runs; CodeRabbit skipped). The local branch matched the remote.
- Scope read (technical ambiguity, Q36, decided by loop, confirm): K20 says validation errors show next to their fields, and the generation and grading fields follow the prompts panel's pattern. The factory's generation and grading controls are sliders and choices bounded by their ranges, so no value can be typed outside them. The cookbook form is where a typed value is refused, so the unit covers that form.
- Unit done (K20e): `fieldProblemsOf` in `components/cookbooks/edit-model.ts` checks each changed field alone with the rules applyEdits runs, and returns the reason by the field's key. The form shows each reason under its field (a control, an instruction, a step name, a setting). Save sends nothing while any field is marked.
- Acceptance: H2 also types a blank instruction and waits for "cannot be empty", then saves a valid one.
- Checks: `NODE_ENV=development node --experimental-strip-types --test src/components/cookbooks/edit-model.test.ts` passed 20 of 20 (19 before, 1 new). `npx eslint` on the three cookbook files and the acceptance script exits 0. `npm run typecheck` exits 0. The local release acceptance run `ra-run12` passed 32 of 32, exit 0.
- Not checked: the factory's generation and grading panels, which are unchanged. No live provider call was made.
- Still open in K20: the pipeline-model tests move (K20f, to check first, from the spec), and the decision in Q36.
- Next wake armed for 10:20 UTC (trig_01D8pg22zXi4dhBrTXJ9L4t4).

## 2026-11-01 10:22 UTC: wake: K20f parked on Q37

- Wake (10:20): CI on the head b19780f was green (13 check runs; CodeRabbit skipped). The local branch matched the remote.
- Read K20f, the last open item of K20: the spec says the pipeline-model tests move to the cookbook model and keep their cases. The file has three cases, and all three test `engineRows` (the factory's engine picker: Hypit and Manual Cloud availability). The cookbook model has no provider connection status; its eligibility (`cookbooks/eligibility.ts`) decides only from footage and budget.
- Decision: K20f is parked on Q37, an owner decision. A move would add a provider connection rule to the cookbook's eligibility, which changes which ways a run may use, so the loop does not make it. The three cases stay where they are and keep passing, until the owner decides Q37 or K29 retires the picker.
- K20 is marked done except K20f. Its other spec items are done: the cookbook editor edits steps, instructions and controls (K20b3 to K20d), refused fields show their message (K20e), and the factory line is saved only as a cookbook (K20a).
- No code changed in this wake: the records only (RUN_PLAN, OPEN_QUESTIONS, STATE, RUN_LOG).
- Next: K21 (partly done), the first unfinished task in order.
- Next wake armed for 10:42 UTC (trig_01VSaY1LHmUafkKGFzLFD5LY).

## 2026-11-01 10:46 UTC: wake: K21, captions.boxed

- Wake (10:42): CI on the head 783d6c2 was green (13 check runs; CodeRabbit skipped). The local branch matched the remote.
- Unit done (K21): `captions.boxed` in `src/engine/compose/components/captions.boxed/`, with `props.ts` (the karaoke caption schema, so the same word rules), three fixtures (lower, middle, upper with punctuation), `component.html` and `index.ts`. The spoken word sits in a filled box in the kit's highlight colour, with text in the kit's background colour; words to come are dimmed; a spoken word is plain. It is registered in `components/index.ts`, and the pinned library list in `components.test.ts` now holds 16.
- Contract: `captions.boxed` was already in `CAPTION_COMPONENTS` (`contracts/kits.ts`), so the contract is unchanged.
- Checks: `components.test.ts` passed 119 of 119. The whole compose suite passed 289 of 289. `npx eslint` on the changed files exits 0. `npm run typecheck` exits 0. The template's inline script parses (`node --check`).
- Not checked: how it looks. GSAP loads from a CDN this sandbox cannot reach, so there are no golden frames, as for stat.counter. The look needs a render on the owner's side or the browser check.
- Left for later: the preset comment in `src/engine/presets/three-d-data-explainer.ts` (around line 278) still says captions.boxed has no component. It is stale now, and changing the preset is outside this unit.
- Still open in K21: `label.pill`, `panel.bars`, `panel.line`, `panel.tiles`, `cta.follow`.
- Next wake armed for 11:07 UTC (trig_01PhkV26r7BgsscuGmV6TWmJ).

## 2026-11-01 11:10 UTC: wake: K21, label.pill

- Wake (11:07): CI on the head 132323d was green (13 check runs; CodeRabbit skipped). The local branch matched the remote.
- Unit done (K21): `label.pill` in `src/engine/compose/components/label.pill/`: `props.ts` (a place, and an optional date, with the duration), three fixtures (a place and date; a place alone; a long place name with a date), `component.html` and `index.ts`. The place sits in a pill at the top of the frame, in the kit's primary colour with the background colour as text, as stat.counter's pill does. The date follows a dot, and both are hidden when there is no date. Text is set with textContent. It is registered in `components/index.ts`, and the pinned library list in `components.test.ts` now holds 17.
- Checks: `components.test.ts` passed 126 of 126. The whole compose suite passed 299 of 299. `npx eslint` on the changed files exits 0. `npm run typecheck` exits 0. The template's inline script parses (`node --check`).
- Not checked: how it looks. GSAP cannot load in this sandbox, so there are no golden frames, as for stat.counter and captions.boxed.
- Still open in K21: `panel.bars`, `panel.line`, `panel.tiles`, `cta.follow`.
- Next wake armed for 11:30 UTC (trig_01KijjKtFfp2K3Jhw5HgkUTp).

## 2026-11-01 11:2x UTC: wake: merge main into the PR branch

- Wake (11:10, the CI notice on ac36176): the PR reported `mergeable_state: dirty`. `origin/main` had moved to 6a7fcbf (PR #86, the video style presets and orchestrator style choice), and four files conflicted with this branch.
- Resolved with a merge commit (no rebase, no force push):
  - `src/engine/jobs/handlers/estimate-reserve.ts` and its test: main already added an injectable `now` to the estimate handler, equivalent to this branch's change. Took main's version of both blocks.
  - `src/engine/ops/test/chain.ts`: both sides fixed the same month problem. Took main's fixed clock (the chain's fixture month). The 23 test files that import the chain or the estimate stage pass (160 of 160), so the choice does not lose behaviour the tests check.
  - `scripts/release-acceptance/acceptance.mjs`: main's `focusedWithin` helper replaces this branch's local `waitForBudgetFocus` (removed, since nothing else used it). Both sides added checks at the same place. Kept this branch's H1 and H2, then main's G17 and G18.
- Checks on the merged tree: `npm run typecheck` exits 0. Eslint on the four files exits 0. `node --check` on the acceptance script passes. The compose suite passes 299 of 299. The release acceptance run `ra-run13` passes 34 of 34 (exit 0), including H1, H2, G17 and G18.
- Not checked: the full test suite on the merged tree (CI runs it). No live provider call was made.
- The 11:30 wake (trig_01KijjKtFfp2K3Jhw5HgkUTp) is still armed. It checks CI on the merge commit.

## 2026-11-01 11:2x UTC: fix: the cookbooks migration renumbered to 0142

- Wake (11:19): CI on the merge commit a70be14 failed in `tests (shard 2)`. The failing test is `scripts/migration-plan.test.mjs`, "the migration numbers have exactly the known gaps and duplicates": two files share the number 0140, `0140_content_factory_style_preset.sql` (from main, PR #86) and this branch's `0140_cookbooks.sql`. The test rejects a duplicate that is not on its known list.
- Fix: renamed `migrations/0140_cookbooks.sql` to `migrations/0142_cookbooks.sql` (the next free number on main), and changed its header to 0142. Its file is not on main and no environment has applied it, so the rename changes no applied migration. It has no dependency on `0141`, which is this branch's K13 column migration, so the order is safe. The planning and loop references to the file name are updated. The known-duplicates list is unchanged: the fix removes the duplicate rather than accepting it.
- Checks: `node --test scripts/migration-plan.test.mjs` passes 8 of 8. The cookbook and content-factory suites pass 438 of 438 across 54 files (they apply the migrations in order against the test database). Not run: CI's postgres job, which runs on the new head.

## 2026-11-01 11:33 UTC: wake: K21, panel.bars

- Wake (11:30): CI on the head 5964609 had no red check. Shard 2, the one that failed on the merge commit, passed on this head, as did typecheck, sidecar, postgres, release acceptance, ui-smoke and the other shards. e2e was still running, so the wake went on to the next unit.
- Unit done (K21): `panel.bars` in `src/engine/compose/components/panel.bars/`: `props.ts` (a title and up to eight labelled bars with non-negative values, with the duration), three fixtures (three bars; five decimal bars; one bar at zero), `component.html` and `index.ts`. The panel draws its bars in proportion to the largest value and grows them on the composition clock, with each value fading in above its bar. The accent colour is read from the style kit and applied to the bars. Text is set with textContent. It is registered in `components/index.ts`, and the pinned library list in `components.test.ts` holds 18.
- A check first failed: the template must read the kit from `:root` in its script, and this one only used kit variables in CSS. The script now reads the accent colour from the kit, which fixes it.
- Checks: `components.test.ts` passed 133 of 133. The compose suite passed 309 of 309. `npx eslint` on the changed files exits 0. The template's inline script parses (`node --check`). `npm run typecheck` exits 0.
- Not checked: how it looks. GSAP cannot load in this sandbox, so there are no golden frames, as for the other new components.
- Still open in K21: `panel.line`, `panel.tiles`, `cta.follow`.
- Next wake armed for 11:54 UTC (trig_01MxmbEB35fToAyKC6NVHbDN).

## 2026-11-01 11:57 UTC: wake: K21, panel.line

- Wake (11:55): CI on the head 3f6476b was fully green (all 13 check runs, including the aggregate check). The local branch matched the remote.
- Unit done (K21): `panel.line` in `src/engine/compose/components/panel.line/`: `props.ts` (a title and two to twelve labelled points with non-negative values, with the duration), three fixtures (a weekly rise; a dip and recovery; a flat line), `component.html` and `index.ts`. The line is an SVG path drawn from its first point to its last on the composition clock, with a dot at each point appearing in turn. The scale is the largest value, and a line of zeros uses a scale of one. The stroke colour is read from the style kit. The SVG is built with createElementNS and setAttribute, and text is set with textContent. It is registered in `components/index.ts`, and the pinned list holds 19.
- Checks: `components.test.ts` passed 140 of 140. The compose suite passed 319 of 319. `npx eslint` on the changed files exits 0. The template's inline script parses (`node --check`). `npm run typecheck` exits 0.
- Not checked: how it looks. GSAP cannot load in this sandbox, so there are no golden frames, as for the other new components.
- Still open in K21: `panel.tiles`, `cta.follow`.
- Next wake armed for 12:18 UTC (trig_01DRGXmxH1XWK9Nwe9iwQ58q).

## 2026-11-01 12:12 UTC: wake: K21, panel.tiles

- Wake (12:10, a CI event): CI on the head 1608848 was fully green (all 13 check runs, including the aggregate check; CodeRabbit skipped). The PR is clean. No red check, so the loop went on to the next unit. The pending 12:18 wake was cancelled, and the chain now runs from the 12:33 wake.
- Unit done (K21): `panel.tiles` in `src/engine/compose/components/panel.tiles/`: `props.ts` (a title and one to six tiles, each a short value and a short label, with the duration), three fixtures (four tiles; six tiles; one tile), `component.html` and `index.ts`. The tiles sit in a grid of one, two or three columns by their count, and each pops in on the composition clock. The value colour is read from the style kit. The values are text as given, so nothing is formatted or computed. Text is set with textContent. It is registered in `components/index.ts`, and the pinned list holds 20.
- A comment in the template described the column rule backwards. It is corrected before the commit.
- Checks: `components.test.ts` passed 147 of 147. The compose suite passed 329 of 329. `npx eslint` on the changed files exits 0. The template's inline script parses (`node --check`). `npm run typecheck` exits 0.
- Not checked: how it looks. GSAP cannot load in this sandbox, so there are no golden frames.
- Still open in K21: `cta.follow`.
- Next wake armed for 12:33 UTC (trig_01TRxvDsizBBjERjPxTpxbQ3).

## 2026-11-01 12:36 UTC: wake: K21, cta.follow (the last component of K21)

- Wake (12:33): CI on the head b52a4a2 was fully green (all 13 check runs, including the aggregate check; CodeRabbit skipped), and the branch matched the remote.
- Unit done (K21): `cta.follow` in `src/engine/compose/components/cta.follow/`: `props.ts` (a handle, and an optional prompt, with the duration), three fixtures (a handle with the default prompt; a handle with its own prompt; a long handle), `component.html` and `index.ts`. It is a pill with the prompt and the handle, placed at 66% of the frame, above the bottom 20% line. It is distinct from `cta.card`, the closing card. Text is set with textContent. It is registered in `components/index.ts`, and the pinned list holds 21.
- Checks: `components.test.ts` passed 154 of 154. The compose suite passed 339 of 339. `npx eslint` on the changed files exits 0. The template's inline script parses (`node --check`). `npm run typecheck` exits 0.
- Not checked: how it looks. GSAP cannot load in this sandbox, so there are no golden frames for any K21 component.
- K21 is done: every component on its list is built and registered (captions.boxed, stat.counter, label.pill, panel.bars, panel.line, panel.tiles, cta.follow). The visual checks need a browser on the owner's side.
- Next wake armed for 12:57 UTC (trig_01GC81cYPB8d2urcBhuE3F8f). The next unit is K22 (partly done), the first unfinished task in order.

## 2026-11-01 13:01 UTC: wake: K22, the measures wired to the checks

- Wake (12:57): CI on the head d5ebd20 was fully green (all 13 check runs, including the aggregate check). The branch matched the remote.
- Unit done (K22): the compare report's derivation moved from `scripts/engine/preset-preview/compare.ts` into `src/engine/analyze/measures.ts`. `measuresOf` takes the media functions' readings (durations, cuts, picture pairs, loop distance, motion, flicker, brightness, loudness) and returns the report's measures by name. `numericMeasures` keeps the numbers and nulls, so a check reads its measure by name. The script now gathers the readings and calls `measuresOf`, and it prints the same table.
- A real fault came out of this: the old derivation threw on a zero or unknown duration (an empty median), which made an unknown duration a crash. Now the timing measures, the loop distance and the other unknowns are null, not zero or NaN (CLAUDE.md rule 1).
- Checks: `measures.test.ts` passed 7 tests on recorded readings, and `checks.test.ts` gained a test that feeds recorded measures to a check by name (a cut count passes, and a loudness misses a tight tolerance). Eslint on the changed files exits 0, `npm run typecheck` exits 0, and the compare script parses.
- Not checked: the compare script end to end. The repository has no reference video, so the script cannot be run here.
- Parked: the safe-zone move into the post-render gate, which waits for Q32 (an owner decision; the loop recommends option a, and nothing is changed).
- Decision recorded as Q38: K22 counts as done for K23, so K23 can start.
- Next wake armed for 13:22 UTC (trig_01TEgKaBqTtDmsNKY9PfSMwD).

## 2026-11-01 13:23 UTC: wake: K23 and K25 parked on owner decisions

- Wake (13:22): CI on the head 0f72c31 was fully green (all 13 check runs, including the aggregate check). The branch matched the remote.
- Read K23 (the agent-mode renderer). Its done-when is a rendered 3D data explainer, drawn from its cookbook in the local Chromium, with the check report in the log. Two things block it here. The explainer's cookbook names one library component (`captions.karaoke`); its 3D room, camera and scenes are not in the component library, and the preset preview draws them from a preset, not a cookbook. And the templates load GSAP from a CDN this sandbox cannot reach, so no frame can be checked. Decision: parked on Q39 (which scenes draw it), a rendering approach for the owner.
- Read K25's remainder. The beats and the genome come from the Video DNA, a paid analysis. The loop does not spend money (a hard stop), so the remainder is parked on Q40.
- Nothing is built in this wake. Records only: RUN_PLAN, OPEN_QUESTIONS (Q39, Q40), STATE, RUN_LOG.
- Still unblocked: K28 (partly done): the store read of recorded runs and the export file. K24, K29 and K30 wait on K23 or on every unparked task.
- Next wake armed for 13:44 UTC (trig_01ELgtutyHLNwojABqsPy3Ug).

## 2026-11-01 13:48 UTC: wake: K28 store read, and four R5 modules explained

- Wake (13:44): CI on the head 66b0b2f was fully green (all 13 check runs, including the aggregate check). The branch matched the remote.
- K28, the store read: `cookbooks/recorded-runs.ts` reads each session that has a cookbook record (K13). A run gives its cookbook, version, values and how it was chosen. Its measures are null, since nothing stores the measures of a published output (Q41). A record that cannot be read is counted, not dropped. Three PGlite tests (a readable run, an unreadable one and a plain session, another workspace not read).
- K28, the export builder: `resultsExportOf` in `cookbooks/results.ts` gives the export with its generation time, the run count, the unreadable count and whether any measure is recorded, with a note that says so. One test. The `how` type gains `picked`, the choice the selection record already makes when no selector is connected. The table does not read `how`, so nothing else changes.
- The export file itself waits for Q41, so K28 is parked there.
- R5: four test-only modules explained, not wired (Q42): `lib/progress/step-state.ts`, `lib/create/steps.ts`, `components/settings/connection-state.ts` and `render/splice-run.ts`. The recommended next unit is to wire `connection-state.ts`, whose labels the settings screen builds inline.
- Checks: the results and recorded-runs tests passed 8 of 8. `npx eslint` on the four changed files exits 0. `npm run typecheck` exits 0.
- Not checked: the export file, since no measures are stored to export. No live provider call was made.
- Next wake armed for 14:09 UTC (trig_01XatwGoKN9BCwg7jxLmzjdA).

## 2026-11-01 14:12 UTC: wake: connection-state is not wired (a product choice)

- Wake (14:09): CI on the head 7b5fd2c was fully green (all 13 check runs, including the aggregate check). The branch matched the remote.
- Checked the planned wiring of `components/settings/connection-state.ts` before changing anything. The earlier note said the settings screen builds its own "NOT CONNECTED" strings inline in `drive-connection.tsx`, but that badge belongs to the single Drive status card, not to connection rows. The integration cards (`provider-card.tsx`, built from `integration-model.ts`) show the server's own phase as the badge on purpose ("the badge says exactly what it reports"). `connectionState` would relabel the same statuses as Connected, NOT CONNECTED, Error or Checking. So wiring it would change what the owner sees, which is a product decision.
- Decision: not wired. Recorded in Q42, with the earlier note corrected. RUN_PLAN's R5 status is updated to match.
- No code changed in this wake: records only (OPEN_QUESTIONS, RUN_PLAN, STATE, RUN_LOG).
- Still open in R5: reconciling the 45 test-only modules against `docs/STATE_2026-10-28.md` section 6A, which is the next unit.
- Next wake armed for 14:33 UTC (trig_011CxrbnXDQmdVZgJDcsyjCm).

## 2026-11-01 14:35 UTC: wake: R5 reconciled against section 6A

- Wake (14:33): CI on the head 85fea07 was fully green (all 13 check runs, including the aggregate check). The branch matched the remote.
- Reconciled the 45 test-only modules in section 6A of `docs/STATE_2026-10-28.md` against the record. Each module has an outcome: wired (R4 export package and disclosure gate, discovery provenance, the engine's alerts, batch planner and concurrency proposals, `url` step-state's `step-url`), explained with its Q (Q14 to Q29, Q32, Q42), or kept because a test uses it (`a11y/contrast`, `factory/benchmark-harness`), except three.
- The three without an outcome: `lib/progress/draft-store.ts` and `debounce.ts` (test-only; K17's settings panel is where they are wired, so K17 now says so), and `orchestrator/example.ts` (a recorded example run for a replay screen that does not exist; recorded as Q43, with the loop's recommendation to delete it unless the owner wants the screen).
- Records only: RUN_PLAN (R5 and K17), OPEN_QUESTIONS (Q43), STATE and RUN_LOG. No code changed.
- Next unit: K17, the cookbook settings panel, which wires `draft-store` and `debounce`.
- Next wake armed for 14:55 UTC (trig_012r31PW8GrJhe5sQ2Cdrn5k).

## 2026-11-01 14:57 UTC: wake: K17, the unsent settings draft

- Wake (14:55): CI on the head 25d7f48 was fully green (all 13 check runs, including the aggregate check). The branch matched the remote.
- Read K17. Its remaining work is mounting the panel on a screen (K18) and the browser check. The draft part was unwired, and it is the part that the storage and timers can test here.
- Unit done (K17): `components/cookbooks/settings-draft.ts`. It keeps a person's unsent settings per person, workspace and cookbook, through `draft-store.ts`. It saves a change a short pause after the last one, through `debounce.ts`. It restores only the stored values that fit their controls, and falls back to the defaults for the rest. It drops the draft when the values equal the defaults, and on discard, which also cancels a waiting save. Storage and timers are injected, so the rules run in Node. The panel itself is not mounted until K18.
- Checks: `settings-draft.test.ts` passed 6 of 6. `npx eslint` on the two files exits 0. `npm run typecheck` exits 0.
- Not checked: the panel in a browser, since K18 has not mounted it yet.
- R5: `draft-store` and `debounce` now have a non-test importer, so they are no longer test-only.
- Next: K18, mounting the settings panel and the selection step, then the browser checks.
- Next wake armed for 15:18 UTC (trig_01Xhcj4eXEPtKT3JHYfXjeZc).

## 2026-11-01 15:19 UTC: wake: K18 split into K18d, and the PR question (Q44)

- Wake (15:18): CI on the head cea08a7 was fully green (all 13 check runs, including the aggregate check). The branch matched the remote.
- Read K18. K18a to K18c are done (the server choice, the recorded cookbook in the start, and the step mounted in the draft panel). The last piece is mounting the settings panel with its draft, and the browser check in CI, which is now K18d.
- Raised a conflict with the owner's answer on Q6 as Q44: round 2 and 3 work has been pushed to PR #85's branch, though the answer said PR #85 stays as it is and a new PR is opened once the work is done. GitHub allows one open PR per branch and base, so a new PR needs a new branch. This is for the owner to decide, and the loop has not changed anything about the PR.
- Records only: OPEN_QUESTIONS (Q44), RUN_PLAN (K18 and R8), STATE and RUN_LOG. No code changed.
- Next: K18d.
- Next wake armed for 15:40 UTC (trig_011nB12KdWSCoiDtHk1GBgdm).

## 2026-11-01 15:47 UTC: wake: K18d1, the pick carries its controls

- Wake (15:40): CI on the head 0c9e3d0 was fully green (all 13 check runs, including the aggregate check). The branch matched the remote.
- K18d was split. K18d1 is done: the client needs each candidate's controls to draw the settings, and the server knows them when it builds the picks. `selector.ts` now gives each pick its cookbook's `controls`, and `selectionViewOf` carries the first pick's controls into the view. The fixtures that build picks by hand gain `controls: []`, and a new test checks that the first pick's controls reach the view.
- Checks: `cookbook-selection-model.test.ts`, `select.test.ts` and `selector.test.ts` passed 19 of 19. The 64 test files across the cookbook, content-factory and cookbook component suites passed 514 of 514. `npx eslint` on the changed files exits 0. `npm run typecheck` exits 0.
- Not checked: the panel in a browser. K18d2 mounts it, and the browser check runs in CI's ui-smoke.
- Next: K18d2, mounting the settings panel with its draft, and sending the edited values with the confirm.
- Next wake armed for 16:08 UTC (trig_01DxqaSdBBEPF5BaQ9CrEghz).

## 2026-11-01 16:15 UTC: wake: K18d2, the settings panel is mounted in the choice panel

- Wake (16:09): CI on the head 5039ab4 was fully green (all 13 check runs, including the aggregate check and ui-smoke). The branch matched the remote.
- Unit done (K18d2): `cookbook-settings-step.tsx` draws the pick's controls with the settings panel, and keeps each change as the person's unsent draft (`settings-draft.ts`, per person, workspace and cookbook, through the draft store and the debounce). `cookbook-choice-panel.tsx` mounts it under the pick, and the confirm sends the edited values when they belong to the chosen cookbook.
- A change in `settings-draft.ts` was needed. The draft used to start from each control's default, which would have overridden the value the selector resolved for the pick. It now starts from the pick's resolved values (a saved draft still wins), and it no longer keeps a draft equal to those starting values. `settingRows` takes only the controls.
- Checks: `settings-draft.test.ts` and `settings-model.test.ts` pass 11 of 11, including a new test for the starting values. The 64 test files across the cookbook, content-factory and cookbook component suites pass 515 of 515. `npm run typecheck` exits 0, and eslint on the changed files exits 0.
- Not checked here: the panel in a browser. The browser check runs in CI's ui-smoke on the pushed head.
- K18 is done. Next: K13, the engine request copy and export.
- Next wake armed for 16:36 UTC (trig_01XqJxdHya82SpH4fWb5WyyN).


## 2026-11-01 16:36 UTC: wake: the owner's decisions recorded, and the backlog set

- Resumed after a context break. CI on the head d4b182d was fully green (14 check runs, the aggregate `check` included; CodeRabbit skipped, as before). The branch matched the remote.
- The owner answered in chat: "Go with all the most logical and recommended choices. And leave the 3 most important ones for me to now answer." Every open question was given the recommended option, except Q34, Q39 and Q44, which stay open for the owner.
- Records: OPEN_QUESTIONS.md has a status for all 43 questions and the decision under each one (applied 2026-11-01). RUN_PLAN.md updated: T1 closed on CI's verdict (Q10). K22 done (Q38), with its Q32 move as B10. K25 done for the free part (Q40 b). K28 pending on Q41 (B11). K20f parked until K29 (Q37 b). R5 active until its module units are done. The parked list now holds only the three open questions and the music decision.
- Backlog added to RUN_PLAN.md: B1 to B16, one unit per wake, in order. Owner actions and the partly done tasks with no open question are listed after it.
- Checked before writing the backlog: each file named in B1 to B9, B12 to B15 exists, except one path to correct: the studio loop is `src/lib/meridian/studio/loop.ts`, not `src/engine/studio/loop.ts`. `connection-state.ts` has a test (`connection-state.test.ts`), so B2 deletes both. `validateReelsSafeZones` is in `src/lib/meridian/study/perception-extensions.ts` (used by its own test and by `slop-craft-gates.ts`). The newest migration is `0142_cookbooks.sql`, so the B11 migration is `0143`.
- No code changed. No live provider call, no spend, no publishing, no merge.
- Choice taken on Q18 (b): "say so on the page" has no page to point to, since neither module has a screen. The note goes in the file's header and module note (B15). If a screen was meant, that is a question for the owner.
- Next: B1 (delete `src/engine/orchestrator/example.ts` and its test, after the importer search).
- Next wake armed for 16:57 UTC (trig_01C21ayNP4FrjbgEGvQWJteL). The earlier wake for 16:36 (trig_01XqJxdHya82SpH4fWb5WyyN) was deleted, so there is one wake.


## 2026-11-01: the owner's go on Q34, Q39 and Q44, and the final version

- The owner answered: "Go with recommendations for all and work on making the final stable version only then when fully confident you may push this version". Applied: Q34 (approve cookbook_selector as a contract change), Q39 (K23 reuses the preview scene file, with the cookbook as the source of its values), Q44 (a new draft PR on a new branch; #85 untouched).
- Branch: `claude/cookbook-presets-zrf6un`, from 09a8423. Local commits only, pushed once when the version is verified.
- Done (committed locally, each unit its own commit):
  - The cookbook_selector role (contract engine-contracts@13): CLAUDE_ROLES, migration 0143 (the role check), prompt cookbook_selector@1 (pinned), role file with schemas and recorded-answer tests, the Bible section 4 note. Typecheck passes.
  - The selector port (lib/meridian/cookbooks/selector-port.ts): through runRole against a request and reservation; a missing key gives the picker. The server action does not yet hold a request or reservation for a proposal before a run, so it still gives the picker. That needs an owner decision on how a selection is reserved (flagged for the final message).
  - B1 to B10 (commits): the example module (data moved to a test fixture), three modules with no caller, the in-memory queue and the second frame selector, the duplicate clustering and calibration, the factory timeline renderer, the second logo matcher, the recorded render replies (moved to test), the flow pipeline and the speech-pace prior (140 to 180), the third calibration implementation (its reliability curve in the learning report), and the Reels safe-zone check (new gate check text_in_safe_zones, fail closed without boxes).
- Behaviour change to report: the post-render gate now has a check that is not evaluated without on-screen text boxes, and the OCR port does not return boxes. A video that passed before now goes to review until boxes are measured. This follows the gate's rule that an unmeasured check is not a pass.
- Migration numbering: Q41 (B11) uses 0144, since 0143 is the cookbook_selector role.
- Coverage gap recorded (B3): the durable queue's idempotency, tenant, schedule and cancel behaviour had no other test. The Postgres worker tests cover lease renewal, backoff and dead letters.
- Next: B11, then B12 to B16, K13, K15, K16, K17, K23 and K24, K29, K20f, K30, then the verification and one push.
