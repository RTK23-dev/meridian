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
