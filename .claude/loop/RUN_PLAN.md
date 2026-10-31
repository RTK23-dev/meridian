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
- Status: `parked` (three failed tries, and then more; see Q10). The gate has stopped without a verdict twice more: at 06:49:55, at the start of source group 4, and at 07:14:00, in source group 0 of a detached re-run. Each group was run on its own and passes, and the steps are recorded in section 10 of `docs/STATE_2026-10-28.md`. The single-process verdict is open. The gate runs typecheck, lint and the scripts tests, and each passes. The source-tests step stopped without a verdict three times (gate-run2, gate-run3, gate-run4), and CI is green on the same head (run 40797459592 on b9483a5). Decision Q10 changes how the source tests run locally. Depends on: none.
- Add `scripts/gate.mjs` and an `npm run gate` script. It runs, in order: typecheck, lint, the scripts tests, the source tests, the build, and the release acceptance. It prints each count and compares it with the baseline above. The engine dry run is reported on its own line as `known red (Q2)`.
- Acceptance: the gate runs on the current head and prints the baseline counts. Record its output summary in `RUN_LOG.md`.

### T2: Short-form research note
- Status: `done`, in `docs/engine/RESEARCH_SHORT_FORM_2026-10.md`. Depends on: none. The note's claims come from search summaries, and the source pages were not opened, so each platform figure is to be checked on its page before it is quoted outside the engine.
- Write `docs/engine/RESEARCH_SHORT_FORM_2026-10.md`. Sources: public creator documentation from TikTok, YouTube Shorts and Instagram Reels, and published short-form editing research, found with WebSearch. Copy the genes, never the content.
- Acceptance: every claim has a dated source link, or is labelled `hypothesis`. Note in the document that no owner reference reels were analysed (Q7).

### T3: Typed configuration for non-secret settings
- Status: `active`. Batches 1 to 4 route every non-secret read in src/lib and src/routes through `config/server-settings.ts`, except three kept on purpose: NODE_ENV, DATABASE_URL and BETTER_AUTH_URL (the auth origin), plus MERIDIAN_LOCAL_DATA_DIR in db.ts. The secret reads (TOKEN_ENCRYPTION_KEY, EXTERNAL_SEMANTIC_KEY, EMAIL_API_KEY, CYCLONE_API_KEY, WEBHOOK_SECRET) remain: 25 reads, decision Q12. The ratchet stands at 38.
- Put every non-secret `process.env` read outside `src/engine/` into one typed module under `src/lib/meridian/config/`, parsed once. Secret reads stay with the credential resolver, which is the allowlisted reader in `src/lib/meridian/credentials/resolve.test.ts`. Engine config readers are a follow-up task, not part of this one.
- Work in batches of about 20 files, each batch green on its own.
- Acceptance: no `process.env` read remains outside the config module and the resolver, and a test enforces it. The readiness report output is unchanged (a snapshot test). Test counts equal the baseline.

### T4: Split `src/lib/meridian/studio/session.server.ts` (1,807 lines)
- Status: `done`, in two batches: the loading block (9bb1a0b), then the execution and review actions (836b370). The largest file is now `session-execute.server.ts`, at 857 lines. Depends on: T1 (relaxed by Q10: CI is the verification of record).
- Split by responsibility. Keep the original path re-exporting the public names, so no caller changes in this task. One commit per split.
- Acceptance: no resulting file over 1,000 lines. Test counts equal the baseline.

### T5: Split `src/lib/meridian/factory/worker.ts` (1,070 lines)
- Status: `done` in `ba2ad93`. The largest file is now `worker.ts`, at 399 lines. Depends on: T1 (relaxed by Q10: CI is the verification of record). Same rules as T4.

### T6: Split `src/lib/meridian/content-factory/service.ts` (1,097 lines)
- Status: `done` in `7ff6f76`. `service.ts` is now a re-export, and the largest module is 376 lines. Depends on: T1 (relaxed by Q10: CI is the verification of record). Same rules as T4.

### T7: Split `src/engine/jobs/orchestrator.ts` (1,722 lines)
- Status: `done` in `1354ef0`. `orchestrator.ts` is now 263 lines, and the largest module is 429 lines. Depends on: T1 (relaxed by Q10: CI is the verification of record).
- `advance(state, event)` stays pure and keeps its behaviour. Move each event family into its own module and keep the public exports. No contract change.
- Acceptance: no file over 1,000 lines. The orchestrator and PGlite tests pass and keep their counts.

### T8: Split `src/engine/api/index.ts` (1,506 lines)
- Status: `done` in `acaf1e8`. `index.ts` is now a re-export of 20 lines, and the largest module is `remake.ts` at 655 lines. Depends on: T1 (relaxed by Q10: CI is the verification of record). Same rules as T7.

### T9: Split `src/engine/assets/router.ts` (1,179) and `src/engine/jobs/handlers/produce-shot.ts` (1,052)
- Status: `done`, in two units under the size rule. T9a, the asset router, is `done` in `6730129`: `router.ts` is 831 lines, with its types and helpers moved out, and the closure kept whole (Q13). T9b, the produce_shot handler, is `done` in `baa3a64`: `produce-shot.ts` is 224 lines, and the largest of its new modules is 325 lines. Depends on: T1 (relaxed by Q10: CI is the verification of record). Same rules as T7.

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
- Status: `done`, with decisions in Q11. The plan gate has two hook checks, and the longest-shot rule is a note. Depends on: T2.
- The planner gate checks the hook window and the re-hook interval at plan time. The values come from configuration, with defaults taken from the T2 note. Each default is marked `hypothesis` unless T2 gives a source.
- Acceptance: fixture tests on hand-labelled cuts, as Bible 6.2 requires (cut times within 2 frames). A plan with a late hook fails the gate on a fixture.

### T13: Browser and UI checks
- Status: `done`. The release acceptance ran locally with the preinstalled Chromium: 25 PASS, 0 FAIL, and the release verified, as the baseline says. Depends on: T4, T5, T6, T11 and T12, or after each UI-touching split.
- Run `node scripts/release-acceptance/run.mjs`. Keep the Content Factory board and its keyboard and contrast checks working.
- Acceptance: 25 of 25, or `not run: browser` with the reason.

### T14: Handoff
- Status: `done`. Section 10 of `docs/STATE_2026-10-28.md` carries the measured numbers, and `docs/FIRST_TEST_RUN.md` section 9 is the owner checklist. The gate's single-process verdict stays open under T1. Depends on: all tasks above.
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


## Round 2: the owner's answers (2026-10-31)

Status: `pending`, `active`, `done` or `parked`, as in round 1. The hard stops still apply: no live provider call, no spend, no publishing,
no merging, no force-push, no contract change without the owner's approval, no new dependency without approval, and no secret printed.

### R1: Save the price data (Q2)
- Status: `done` in `c50f228`. Files in `docs/data/prices/`, generated by `npm run prices:export`, with a drift test.

### R2: Secret reads behind one accessor (Q12)
- Status: `done` in `ea5fece`. 24 direct reads moved to `src/lib/meridian/credentials/secret-settings.ts`, and the ratchet is 14. A test
  fails when any app file reads one of the five names directly.

### R3: E6 engine operations (Q4)
- Status: `done` in `f3a7034`, except the browser check. A page at `/engine-ops` shows the workspace's stage metrics and provider health,
  lists a request's dead jobs, and lets an admin replay one. The browser check (AGENTS rule 11) is still to do.

### R4: Export package and disclosure gate (Q5)
- Status: `done` in `f3a7034`, blocked by design until the owner decides. The package is on the Exports screen and passes the disclosure check
  first. Every Meridian-made creative is treated as AI-generated, so it is blocked, and the screen says why. To unblock it, the owner must
  decide two things: whether a C2PA signing library may be added (a new dependency), and whether any footage counts as real.

### R5: The 45 test-only modules (Q3)
- Status: `active`, 3 of 45 wired so far: the export package and the disclosure gate (R4), and the engine alerts (`ops/alerts-sql.ts`, shown as "Alerts right now" on `/engine-ops`, Q14). The owner's answer to Q3 is to make each one work, or to say clearly why it cannot. The other 42 are handled one group at a time, next the engine's batch and concurrency modules (`ops/batch.ts`, `ops/concurrency.ts`). Each module is either wired into a product path, or it is explained in plain words as one that cannot be made to work
  yet, with the reason. Done in groups: the disclosure gate and the export package (R4), the engine's ops modules, then the learning modules.

### R6: Reference videos by upload or public link (Q7)
- Status: `parked`, needs the owner's decisions. A local upload already works in the Content Factory. A public link needs three decisions first:
  which kinds of link are allowed (direct video files only, or platform pages too, whose terms restrict downloading), the size limit, and the
  list of allowed hosts. Without the host list, fetching a link would reach private addresses, so the check must be designed with the owner.

### R7: Research data (Q2, the second half)
- Status: `done` as a proposal, `docs/data/RESEARCH_DATA_PLAN.md`. Six decisions for the owner, in section 4, before anything is built.

### R8: New pull request (Q6, Q8)
- Status: `pending`. Open one new draft pull request once R5 and R6 are settled, and leave PR #85 unchanged. The owner said: when the changes are done.
