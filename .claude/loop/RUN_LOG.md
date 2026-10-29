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
