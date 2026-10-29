# Run plan: the week's coding run

Status: `pending`, `active`, `done` or `parked`. Work top to bottom. A task starts when its dependencies are `done`. The loop does one unit per wake-up (see the coding-loop skill).

## Baseline

Measured on `main` at `0aa3301` and on this branch at `7723e39`, in PR #85. Every task below must keep these numbers or improve them.

| Check | Baseline |
| --- | --- |
| Typecheck, `npm run typecheck` | pass |
| Lint, `npm run lint` | 0 errors, 4 warnings |
| Source tests | 6,690: 6,649 pass, 0 fail, 41 skipped |
| Scripts tests | 220: 217 pass, 0 fail, 3 skipped |
| Build, `npm run build` | pass |
| Release acceptance, `node scripts/release-acceptance/run.mjs` | 25 of 25 |
| Engine dry run, `npm run engine:e1 -- --dry-run` | FAIL, 0 of 1 (`ledger_bill_settles_render_cost`). Owner decision Q2. Not a gate failure. |

The browser step needs the preinstalled Chromium. If it cannot launch, the check is reported as `not run: browser`. It is never reported as passed.

## Tasks

### T1: Stability gate
- Status: `active`, verdict blocked. The gate runs typecheck, lint and the scripts tests, and each passes. The source-tests step stopped without a verdict three times (gate-run2, gate-run3, gate-run4), and CI is green on the same head (run 40797459592 on b9483a5). Decision Q10 changes how the source tests run locally. Depends on: none.
- Add `scripts/gate.mjs` and an `npm run gate` script. It runs, in order: typecheck, lint, the scripts tests, the source tests, the build, and the release acceptance. It prints each count and compares it with the baseline above. The engine dry run is reported on its own line as `known red (Q2)`.
- Acceptance: the gate runs on the current head and prints the baseline counts. Record its output summary in `RUN_LOG.md`.

### T2: Short-form research note
- Status: `pending`. Depends on: none.
- Write `docs/engine/RESEARCH_SHORT_FORM_2026-10.md`. Sources: public creator documentation from TikTok, YouTube Shorts and Instagram Reels, and published short-form editing research, found with WebSearch. Copy the genes, never the content.
- Acceptance: every claim has a dated source link, or is labelled `hypothesis`. Note in the document that no owner reference reels were analysed (Q7).

### T3: Typed configuration for non-secret settings
- Status: `pending`. Depends on: T1.
- Put every non-secret `process.env` read outside `src/engine/` into one typed module under `src/lib/meridian/config/`, parsed once. Secret reads stay with the credential resolver, which is the allowlisted reader in `src/lib/meridian/credentials/resolve.test.ts`. Engine config readers are a follow-up task, not part of this one.
- Work in batches of about 20 files, each batch green on its own.
- Acceptance: no `process.env` read remains outside the config module and the resolver, and a test enforces it. The readiness report output is unchanged (a snapshot test). Test counts equal the baseline.

### T4: Split `src/lib/meridian/studio/session.server.ts` (1,807 lines)
- Status: `pending`. Depends on: T1.
- Split by responsibility. Keep the original path re-exporting the public names, so no caller changes in this task. One commit per split.
- Acceptance: no resulting file over 1,000 lines. Test counts equal the baseline.

### T5: Split `src/lib/meridian/factory/worker.ts` (1,070 lines)
- Status: `pending`. Depends on: T1. Same rules as T4.

### T6: Split `src/lib/meridian/content-factory/service.ts` (1,097 lines)
- Status: `pending`. Depends on: T1. Same rules as T4.

### T7: Split `src/engine/jobs/orchestrator.ts` (1,722 lines)
- Status: `pending`. Depends on: T1.
- `advance(state, event)` stays pure and keeps its behaviour. Move each event family into its own module and keep the public exports. No contract change.
- Acceptance: no file over 1,000 lines. The orchestrator and PGlite tests pass and keep their counts.

### T8: Split `src/engine/api/index.ts` (1,506 lines)
- Status: `pending`. Depends on: T1. Same rules as T7.

### T9: Split `src/engine/assets/router.ts` (1,179) and `src/engine/jobs/handlers/produce-shot.ts` (1,052)
- Status: `pending`. Depends on: T1. Same rules as T7.

### T10: Preset inventory and proposal (document only)
- Status: `done`, in `docs/engine/PRESET_MODEL_PROPOSAL.md` (commit in the run log, 01:20 UTC). Depends on: none.
- Write `docs/engine/PRESET_MODEL_PROPOSAL.md`. List every look (`LOOK_PRESETS` in `src/engine/contracts/edl.ts`, and the overlay table in `src/engine/compose/compiler.ts`), every repurpose category and option (`src/engine/repurpose/catalog.ts`), and the caption and grammar fields that behave like presets. Each entry gets a file and line reference. Say which parts need a contract change. Do not edit `src/`.
- Acceptance: the list is complete against a grep, and any contract change is named as a question for Q1.

### T11: One preset registry, on the existing contracts
- Status: `done`. The look overlays are in `src/engine/compose/looks.ts`, and the compiler reads them through `resolveLook`. Depends on: T10.
- One registry module that every look and option resolves through. An unknown preset is refused with a typed error (fail closed). The look table in the compiler is replaced by the registry.
- No contract change in this task. Fields the proposal says are missing are not added here (Q1).
- Acceptance: one test per preset. The compose snapshots are unchanged. A grep shows no second look table.

### T12: Hook timing rules as configuration
- Status: `pending`. Depends on: T2.
- The planner gate checks the hook window and the re-hook interval at plan time. The values come from configuration, with defaults taken from the T2 note. Each default is marked `hypothesis` unless T2 gives a source.
- Acceptance: fixture tests on hand-labelled cuts, as Bible 6.2 requires (cut times within 2 frames). A plan with a late hook fails the gate on a fixture.

### T13: Browser and UI checks
- Status: `pending`. Depends on: T4, T5, T6, T11 and T12, or after each UI-touching split.
- Run `node scripts/release-acceptance/run.mjs`. Keep the Content Factory board and its keyboard and contrast checks working.
- Acceptance: 25 of 25, or `not run: browser` with the reason.

### T14: Handoff
- Status: `pending`. Depends on: all tasks above.
- Update `docs/STATE_2026-10-28.md` section 10 with the new numbers. Update `docs/FIRST_TEST_RUN.md` with an owner checklist for the live steps. Run the gate once more on the final commit and record it.

## Parked (owner decisions)

These tasks are not started, because the owner must decide them. Each one is recorded in `OPEN_QUESTIONS.md`.

- Preset fields that need a contract change: Q1. Blocks: no task in this run, unless Q1 is approved.
- E1 dry-run policy: Q2. Blocks: none. The gate reports the dry run as known red.
- The 45 test-only modules: Q3. Blocks: none. Left untouched.
- Engine-ops E6 server functions: Q4. Blocks: none. Left untouched.
- Export package and disclosure gate: Q5. Blocks: none. Left untouched.
- PR #85 and the branch: Q6. Blocks: none. The run stacks on the branch.
- Reference reels for research: Q7. Blocks: the reel-based part of T12. T12 uses hand-labelled fixtures.
- One PR or several for this run: Q8. Blocks: none.
- Music vendor and disclosure wording (Bible 20.2): out of scope for this run.
