# Run state

Single loop, lead only, no subagents (owner, 2026-10-20). Current run: branch `run/orchestrator-budgets-2026-10-23`, from `origin/main` 19223045, with `origin/main` 671f076f merged in by `40a17cf2`. The docs for it are on `docs/run-budgets-2026-10-23`. Governing plan: `REPLAN_2026-10-23.md`. Decisions: `DECISIONS_2026-10-23.md` (D1 to D17). The 2026-10-22 run numbered its own decisions D1 to D5 (`DECISIONS_2026-10-22.md`); the numbers in this file are the 2026-10-23 decisions.

## Log

- 2026-10-20 to 2026-10-22, branch `run/factory-6h`: the orchestrator core (plans, validation, surgical edits, executor, layout, replay), the planner, the live catalog snapshot, the plan store and runner, the orchestrator model in the Content Factory panel, and the production handlers for reference, analysis and script with the run reservation. Commits and gates are in the PHASE_LOG entries for those dates.
- 2026-10-23, the budget run, in order:
  - `8b619aa2` run plan. `870ccf86` default model family off, as a workspace policy (migration 0114). `45c05127` an early budget rule, replaced the same day under D12. `ddc51db4` category budgets (migration 0116). `afaaee74` model brief and priced candidates. `b48cd74c` approval, composer and policy panel. `4be77e79` and `6854260b` fixes from the browser check on the dev server. `26947cf9` documents. `5ac241b6` gates of that stage.
  - `40a17cf2` merge of origin/main `671f076f`. `34f31e55` three settings tests updated to main's status for a usable saved key.
  - `18175b03` D12 to D16 recorded. `6862bb52` budget-line and measure-mode modules. `8ef72ca5` CLAUDE.md rule 3 and the handoff's rule 7 state the line.
  - `ff5ef05b` queued holds and measure-mode primitives (D14, D15). `bbba4799` brief path reads the budget as a line (contract v11). `66d2ade0` approval audit and brand override store (D13, D16). `45ce8ff1` orchestrator line (D12, D14, D15, D17). `f0eb8049` D17 recorded. `7ad9ae32` brief path applies D17.
  - `d8f104f9` queued job closes once. `4ead4dbb` queued-hold test passes the line. `f867dcc6` wave 3 backend (measure mode, brand wiring, averages). `5342dce3` unreadable policy refuses; role and tenancy tests. `a5490585` follow-ups (brand families on every route; measured edits match planning).
  - The docs commit on `docs/run-budgets-2026-10-23` follows `a5490585`.
- Gates: test totals to be filled at release. No live run has happened.

## Current state

| Area | State |
|---|---|
| Budget is a line (D12); a paid step starts only if its own hold fits (D17) | Built and tested on fixtures, in the brief path (contract v11) and the orchestrator. Contract v11 lead approval pending |
| Orchestrator planning, validation, executor and run | Built on fixtures; planner prompt `orchestrator_plan@4` |
| Category budgets (D3, D8; migration 0116) | Built on fixtures |
| Model brief (D6, D10) | Built; lists only the models the engine can price |
| Queued holds (D14; migration 0117) | Built on fixtures |
| Measure mode (D15; migration 0117) | Built on fixtures. Initial ceiling 0.50 USD per second, adjustable within the range set in `policy-store.ts` |
| Approval audit (D13; migration 0118) | Built on fixtures. The brief path has no approval flow |
| Brand override (D16; migration 0119) | Built on fixtures |
| Workspace policy (D1; migration 0114) | Built. Default model family off. An unreadable row refuses |
| Live runs | None. No provider key is set in this environment. The first live test has not been run |
| Test totals | To be filled at release |

## Blocked on the owner

- An OpenRouter key in the environment, with a credit limit set on OpenRouter's side. That is the only way the live steps can run.
- The default model family (D1) against main's operating brief. PHASE_LOG 2026-10-23, open item 4.
- The retry after a settle conflict (open item 2), and whether a draft with no brand records the acting brand (open item 5).
- Two concurrent runs in one workspace (D12), and price forms other than a per-second USD video rate (D10).
- Which CLAUDE.md governs (open item 3). The consolidated file does not list the earlier file's Known conflicts (storage, live runs, the step before the first phase, and Hypit). The owner settles those.
- Open decisions in the Bible 20.2 list.

## Pushed head a2a0dc1 (2026-10-21)

Superseded by the 2026-10-23 run. The head and gates of that date are in the PHASE_LOG entries of 2026-10-21. Items still open from it are in the sections above.

## Block: planning service, live catalog reader, plans UI (2026-10-21)

- Built on fixtures: the orchestrator role and its migration (`0108_orchestrator_plans.sql`, `ef0152e`), the planning service and the live catalog reader (`c82d871`), and the canvas that fits its width (`33ebfb7`). No live planning call has been made.
- Production step handlers for the other step kinds are not built. See the 2026-10-22 section.

## Block: orchestrator model stored in the Content Factory panel (2026-10-21)

- Migration `0109_orchestrator_settings.sql` stores the workspace's orchestrator model. The live catalog was not read, because no key is set. The signed-in screen was not browser-checked at the time.

## 2026-10-22, production handlers and run budget

- Built on fixtures: step bodies (migration 0110), the run reservation (`run-budget.ts`), text handlers for reference, analysis and script (`production.ts`), and failed-hold accounting. Decisions D1 to D5 of that run are in `DECISIONS_2026-10-22.md`.
- Still open: handlers for visual, voice, video, avatar, edit, compose and render; re-render wiring; every live run.

## Run 2026-10-23: budget lines, delegated category budgets, model brief, default model family off

Governing plan: `REPLAN_2026-10-23.md`. Decisions: `DECISIONS_2026-10-23.md`. Code head at this docs commit: `a5490585`.

Decision status:
- D1: default model family off, as a workspace policy (`870ccf86`; migration 0114). It conflicts with main's operating brief (PHASE_LOG open item 4).
- D2: superseded by D12.
- D3 and D8: category budgets built (`ddc51db4`; migration 0116).
- D4: the plan schema is unchanged.
- D5: the planner prompt is `orchestrator_plan@4` in code. D5 set @3; @4 states the budget as a line.
- D6 and D10: the model brief (`afaaee74`) and the priced candidates.
- D7: unchanged.
- D9: not used in this run.
- D11: approval built (`b48cd74c`). It raises both budgets, and the run is started again by hand.
- D12: built in the brief path (`bbba4799`) and the orchestrator (`45ce8ff1`). The key that D12 retired is dropped on read.
- D13: approval audit (`66d2ade0`; migration 0118).
- D14: queued holds (`ff5ef05b`, `d8f104f9`; migration 0117).
- D15: measure mode (`ff5ef05b`, `6862bb52`, `f867dcc6`; migration 0117 for the cost table).
- D16: brand override (`66d2ade0`, `f867dcc6`, `a5490585`; migration 0119).
- D17: the fit rule in the brief path (`7ad9ae32`) and the orchestrator (`45ce8ff1`). The pause wording is in `src/engine/orchestrator/execute.ts`.

Notes for the lead:
- Migrations 0118 and 0119 are on this branch. Another branch with the same numbers trips the numbering test (`STATUS_APPROVALS_BRAND.md`, item 6).
- D14 names the column `estimate_usd`. Migration 0117 names `held_usd` and `hold_usd`. The migration is the record.
- The header comments of migrations 0114 and 0115 still describe the retired rule. Migrations were not changed in this run.
- The handoff's rule 7 and CLAUDE.md rule 3 state the line but not the fit rule (D17). They are not on this run's list, so they are unchanged.
- Two comments in `src/` were reworded in this docs commit, and no code changed: `src/engine/contracts/ledger.ts` (lines 12 and 13) and `src/engine/jobs/STATUS.md` (lines 13 and 14).

Open items are listed in PHASE_LOG 2026-10-23.
