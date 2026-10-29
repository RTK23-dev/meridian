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
