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
- Status: `active`, reconciled on 14:34 against section 6A of `docs/STATE_2026-10-28.md`: every module on the list has a recorded outcome (wired, explained with its Q, or kept because a test uses it), except three. `lib/progress/draft-store.ts` and `debounce.ts` are wired by `components/cookbooks/settings-draft.ts` (K17, 14:57), so they are no longer test-only. `orchestrator/example.ts` waits on Q43. So R5 is done apart from those three. 6 of 45 wired so far. On 13:48 four more were explained, not wired, with the reasons in Q42: `lib/progress/step-state.ts`, `lib/create/steps.ts`, `components/settings/connection-state.ts` and `render/splice-run.ts`. `connection-state.ts` is not wired (14:12, Q42): the integration cards show the server's phase as their badge on purpose (`integration-model.ts`), and this module would relabel the same statuses, which is the owner's call. The next unit is to reconcile the 45 against `docs/STATE_2026-10-28.md` section 6A: the export package and the disclosure gate (R4), the discovery provenance (`discovery/provenance.ts`, shown as "Where it was seen" on each stored Market page, read-only, brand-scoped), the engine alerts (`ops/alerts-sql.ts`, shown as "Alerts right now" on `/engine-ops`, Q14), the batch planner (`ops/batch.ts`, shown as "Batch requests" on `/engine-ops`, Q15), and the concurrency proposals (`ops/concurrency.ts`, shown as "Concurrency proposals" on `/engine-ops`, held at every size until calls record their bucket, Q16). The owner's answer to Q3 is to make each one work, or to say clearly why it cannot. The four learning modules (`fatigue`, `guardrails`, `organic-telemetry`, `parameters`) are explained, not wired: wiring each one changes learning, scoring or product direction, so each waits for the owner (Q17). `studio/loop.ts` and `study/deep-study-service.ts` are explained, not wired (Q18): the loop runs on test providers, and the deep study depends on model-backed JEV judgment, so wiring either one would show fixture output as real or start model calls. `production/route.ts`, `production/rework-engine.ts` and `production/voice-director.ts` are explained, not wired (Q19): approval routing is a decision for you, the rework engine needs the footage-rights decision from R4 and has a placeholder music asset, and the voice plan needs a voice vendor and consented voices. `jobs/durable.ts` (an in-memory queue, a second one next to the Postgres worker) and `video/scene-frames.ts` (a second frame selector, next to the one image QC uses) are explained, not wired (Q20): wiring either would build a parallel pipeline or change every visual judgment, and deleting them is the owner's decision. `flow/nodes.ts` (a second pipeline with the same stages as the Factory) and `grading/priors.ts` (labelled seed priors that scoring would use) are explained, not wired (Q21): wiring the first would build a parallel pipeline, and wiring the second changes scoring before a calibration report exists. `intelligence/cluster.ts` (a second clustering, next to the one in `intelligence/whitespace.ts` that the opportunity engine uses) and `jev/calibration.ts` (a second Brier and log-loss, next to the calibration reports the product uses) are explained, not wired (Q22): both duplicate product code, and deleting them is the owner's decision. The `organic/*` group (eight files: the Instagram creator, reel and comment modules, and their learning bridge) is explained, not wired (Q23): its entry point, `factory/instagram-volume.ts`, asks Apify for about 1,000 reel candidates per niche per week, which is paid spend and needs the owner's approval, and the learning bridge writes into learning, which is scoring. Nothing in the product calls the group. `quality/evidence.ts` (freshness labels no screen shows yet) and `shopify/reel-attribution.ts` (tracked reel links, which the publish step should call) are explained, not wired (Q24): the first is a display choice, and the second changes every published reel's link, which is an outward change for you to approve. `calibration/report.ts` is a third calibration implementation with no caller, next to `learning/calibration-report.ts` (which the calibration screen uses) and `jev/calibration.ts` (Q22). It is explained, not wired (Q25). `discovery/provenance.ts` is wired (17:52): `itemProvenanceFor` checks brand access the way `listDiscoveredItemsFor` does, `getDiscoveredItemProvenance` exposes it, and each stored Market page has a "Where it was seen" disclosure that loads on open. Tests: `provenance-view.test.ts` (1 of 1, PGlite). The existing `source-provenance.test.ts` still passes (3 of 3). Browser check of the Market page: CI's `ui-smoke` job, not run here. The rest of the feature-code list in section 6A of `docs/STATE_2026-10-28.md` is next. `storage/filesystem.ts` (a local-disk object store on the engine's object-store port, next to the Drive-backed store) and `vision/logo.ts` (a second logo matcher next to `vision/measure.ts`, which image QC uses) are explained, not wired (Q26): a second storage backend is a storage-location decision, and the second logo matcher duplicates the one in use. `a11y/contrast.ts` is not dead code: `src/components/ui/tokens.test.ts` uses it to check the theme's contrast ratios, so it guards accessibility (AGENTS rule 11) and needs no change. `factory/cost.ts` (a stage-cost rollup and a budget check) has no caller at all, and wiring it adds a spend check, which is the owner's decision (Q27). `factory/render.ts` (a timeline builder with no caller, whose clips come from the fixture helpers in `video/inspect.ts`) is explained, not wired (Q28): wiring it would make fixture clips look like a render. `factory/benchmark-harness.ts` is in use by its own test (`benchmark-harness.test.ts`), which checks the opportunity ranking against a hand-labelled gold set, so it needs no product change (the same treatment as `a11y/contrast.ts`). The four engine modules are explained, not wired (Q29): `engine/jobs/review-decision.ts` writes engine approval decisions (with `engine/review/labels.ts` and `engine/review/take/gold.ts`, which only it uses), so wiring it changes approvals; `engine/assets/firstLastFrame.ts` is a frame test that would call paid video providers, so it needs the owner's spend approval; `engine/render/recorded.ts` is a fixture of recorded render replies that neither the E1 script nor the product uses. `gates/slop-craft-gates.ts` is explained, not wired (Q32): four of its inputs (morphing faces, garbled text, plastic skin, robot voice) have no measurement in Meridian, so wiring it would feed it guesses; its loudness check duplicates the engine's post-render gate, and its flicker check duplicates the render-integrity detector. Its safe-zone check is the one part worth keeping. Still on the list after this: `lib/progress/*`, `lib/create/steps.ts`, `components/settings/connection-state.ts` and `render/splice-run.ts` (documented, not built). Each is checked with exact import patterns first. Each module is either wired into a product path, or it is explained in plain words as one that cannot be made to work
  yet, with the reason. Done in groups: the disclosure gate and the export package (R4), the engine's ops modules, then the learning modules.

### R6: Reference videos by upload or public link (Q7)
- Status: `parked`, needs the owner's decisions. A local upload already works in the Content Factory. A public link needs three decisions first:
  which kinds of link are allowed (direct video files only, or platform pages too, whose terms restrict downloading), the size limit, and the
  list of allowed hosts. Without the host list, fetching a link would reach private addresses, so the check must be designed with the owner.

### R7: Research data (Q2, the second half)
- Status: `done` as a proposal, `docs/data/RESEARCH_DATA_PLAN.md`. Six decisions for the owner, in section 4, before anything is built.

### R8: New pull request (Q6, Q8)
- Status: `pending`. Open one new draft pull request once R5 and R6 are settled, and leave PR #85 unchanged. The owner said: when the changes are done.

## Round 3: cookbook presets (the owner's go, 2026-10-31)

The design is `docs/planning/COOKBOOK_PRESETS_PLAN.md`. This section is the task list the loop works from, top to bottom, one unit per
wake. Status: `pending`, `active`, `done` or `parked`, as in rounds 1 and 2.

### The owner's answers (Q31, 2026-10-31)

- D1, engine integration: yes, with a new requirement. The engine picks the right cookbook from the inputs with a small decision-model
  call. In normal use (not a fully automated loop) the person sees the pick, can change the cookbook and adjust its settings, and only
  then sends the final request to the orchestrator. In an automated loop the pick is accepted as is and recorded as auto-accepted. The
  contract change this needs (`engine-contracts@12`: a cookbook reference, its values and per-role instructions on the request) is
  approved as part of this answer. This also settles Q1.
- D2: yes. Agent-mode videos pass the same review, disclosure and publish gates, labelled with how they were made.
- D3: both. A custom cookbook is visible to its brand or to the whole workspace, by the creator's choice; brand by default.
- D4: replace and improve, do not scrap. The factory pipeline presets, the pipeline editor, the preset bar, the content hub's start
  modes, the style presets, the repurpose catalog and the unused flow modules are upgraded into the cookbook system, and their useful
  parts and tests are kept. Old data is migrated, not dropped. A module is removed only after its replacement covers it and its tests
  have moved.
- D5: agreed. Editors edit their own cookbooks' instructions; admins edit copies of built-ins.
- D6: yes. Option values are recorded with run results for the research agents.

### Rules for this round

- The hard stops still apply: no live provider call, no spend, no publishing, no merging, no force-push, no new dependency without
  approval, no secret printed. The contract change in K14 is approved (D1). Any other contract change still needs the owner.
- Every model call in this round is a role through `runRole`, tested with recorded answers. The selector's live run is the owner's.
- Fail closed: when the selector is not connected, the screen says so and the person picks; nothing is picked for them by a guess.
- Each task ends green: focused tests, `npx eslint` on the changed files, `npm run typecheck`. CI on the pushed head is the
  verification of record (Q10). UI tasks add or extend a ui-smoke path and check the page in a browser when one can launch.
- Every new screen keeps role checks (`hasRole`) on mutations and tenancy checks on every server function.

### Stage 0: finish round 2

#### K0: The last four test-only modules (R5)
- Status: `done`. Depends on: none. Result (2026-10-31, exact import checks):
  - `lib/progress/step-url.ts` is already used by `components/home/home-model.ts`, so it is wired. Its siblings: `step-state.ts` is used only by `lib/create/steps.ts`; `debounce.ts` and `draft-store.ts` have no product caller.
  - `lib/create/steps.ts` (the Create step bar) has no caller: the `/create` routes do not exist. Explained, not wired (Q33).
  - `components/settings/connection-state.ts` is a second connection-label mapping next to `integrationCards` on `/integrations`. Wiring it would change the labels people see. Explained, not wired (Q33).
  - `engine/render/splice-run.ts` runs a splice render whose only window renderer returns `not_connected` (honest, but nothing calls it). Explained, not wired (Q33).
  - `debounce.ts` and `draft-store.ts` (saved drafts that survive a reload, 600 ms debounce) are the right tools for the cookbook settings panel and editor. They are wired in K17 and K20, not here, so this task does not add browser storage to a screen by itself.
- Done when: met. R5 reads 6 wired, 34 explained, 4 of them listed in Q33, and K17 and K20 pick up `draft-store` and `debounce`.
- `lib/progress/*`, `lib/create/steps.ts`, `components/settings/connection-state.ts`, `render/splice-run.ts`: check each with exact
  import patterns; wire it if it is a read or a test-gate fit with no owner decision, otherwise explain it with a question.
  `lib/create/steps.ts` (brief, plan, review steps) is a candidate for the K17 selection step: note it there rather than deleting it.
- Done when: R5 is `done` with every module wired or explained; RUN_PLAN, STATE and the PR #85 description carry the final count.

### Stage 1: the cookbook core (pure code, no storage)

#### K1: One control schema
- Status: `done` (`src/lib/meridian/cookbooks/controls.ts`, 9 tests: all 14 component declarations parse; every kind refuses its own bad values with the field named; bindings are the four fixed shapes). Depends on: K0.
- `src/lib/meridian/cookbooks/controls.ts`: zod schemas for `toggle`, `slider`, `select`, `text` and `colour` controls (section 3 of
  the design). A parser turns each compose component's `data-composition-variables` (enum, number, string) into the same schema.
- Tests: every `component.html` in `src/engine/compose/components/` parses; a malformed declaration fails with its field named.
- Done when: the component variables and cookbook controls share one type.

#### K2: The cookbook schema and validator
- Status: `done` (`cookbooks/schema.ts` and `validate.ts`, 18 tests: each rule has a failing case; a component path binds only with its declaration and a step that uses the component). Depends on: K1.
- `cookbooks/schema.ts` (`meridian.cookbook/v1`: meta, modes, ingredients, steps, instructions, style, grammar, controls, checks) and
  `cookbooks/validate.ts` (`validateCookbook`): the six rules of the design's section 3 (paths exist, ranges inside engine bounds,
  unique ids, no cycles, no expressions, bounded instruction text, unknown prices stay unknown).
- Tests: one passing and one failing case per rule.

#### K3: The resolver
- Status: `done` (`cookbooks/resolve.ts`, 15 tests; the cost classes use the engine's own `shotCost`, `prices.routeFor` and units; an unknown price is never 0; agent mode needs every chosen way free; the plan template passes the orchestrator's `planNodeSchema`). Depends on: K2.
- `cookbooks/resolve.ts`, `resolveCookbook(cookbook, values, context)`, pure. It fills defaults and applies the bindings, then works out:
  - the requirements with their cost class (free, paid or unknown), from `engine/plan/tables.ts` RECIPES, `plan/cost.ts` and
    `config/prices.ts`;
  - the estimate, with unknown lines named;
  - the modes the values allow (agent, engine);
  - the badge.
- Its outputs: `request` (fields for `buildProductionRequest`), `planTemplate` (orchestrator nodes) and `agentBrief`.
- Tests: golden outputs per built-in and values set. The same input gives the same output byte for byte. An unknown control or an
  out-of-range value is refused as `invalid_input`. A missing price stays `null`.

#### K4: The 3D data explainer as the first built-in cookbook
- Status: `done` (`cookbooks/builtin/three-d-data-explainer.ts`, built from the preset: style, structure, cut rule and checks are read from it; 11 tests, including the agent-mode default, the voice-over and generated-shot changes, length, toggles and the plan template). The validator also gained a lookup-table map (a select sets a number through a table), tested.
- `cookbooks/builtin/3d-data-explainer.ts`, built from `src/engine/presets/three-d-data-explainer.ts` (version 2), with:
  - the options in section 1 of the design (voice-over, music, pace, camera energy, data panels, hook counter, length, caption
    highlight);
  - its instructions;
  - checks from the measured targets.
- `src/engine/presets/` stays the source of the style and grammar data; the cookbook reads it rather than copying it.
- Tests: it validates. Turning on "Voice-over: AI voice" removes agent mode and adds a voice line.

#### K5: Bring the existing presets in (D4)
- Status: `done` (`cookbooks/builtin/factory-presets.ts`, 12 tests: each of the four factory presets, resolved through its cookbook, gives back exactly `getPresetConfig`; the three start modes are blank cookbooks; the style is optional, because the theme page decides it at run time). Deferred to K19: the repurpose catalog's `packs` capability stays unavailable until the cookbook library exists, since making it available means a pick screen that K19 builds.
- Each of the five factory pipeline presets (`viral_ugc`, `problem_solution`, `strict_quality`, `manual_cloud`, `custom`) becomes a
  built-in cookbook through an adapter: stages become steps, the four prompt texts become step instructions, and the generation params
  and thresholds become controls with the same ranges the validator enforces today.
- The content hub's start modes (brief, reference, studio) become the three "blank" cookbooks.
- The repurpose catalog's `packs` capability becomes available, pointing at cookbooks.
- Tests: each old preset, resolved through its cookbook, gives the same stages, prompts and params as `getPresetConfig` gives today
  (the old tests keep passing).

### Stage 2: storage and server functions

#### K6: The cookbooks table and store
- Status: `done` (migration `0142_cookbooks.sql`; `cookbooks/store.ts`: save the next version, latest visible version, list, fork and archive; 8 PGlite tests: immutable numbered versions, brand and workspace visibility, a kept brand, forks with parents, archived-but-resolvable, reserved built-in ids, another workspace not found, and a body validated on the way in).
- Migration `migrations/0142_cookbooks.sql`. Columns: `id`, `organization_id`, `brand_id` (null when visible to the whole
  workspace, D3), `cookbook_id`, `version`, `parent_cookbook_id`, `parent_version`, `body jsonb`, `content_hash`, `created_by`,
  `created_at`, `archived_at`. Unique on `(organization_id, cookbook_id, version)`.
- `cookbooks/store.ts`: list (built-ins, plus this workspace's, plus this brand's), get (latest or a version), save the next version,
  fork, and archive. Rows are immutable.
- Tests (PGlite): versions are immutable; a fork keeps its parent; a brand cookbook is invisible to another brand and visible across
  the workspace when shared; an archived cookbook is not listed but still resolves for old runs.

#### K7: Server functions and roles
- Status: `done` (`cookbooks/service.ts` with the rules, tested on PGlite: 9 tests; `cookbooks/policy.ts`, 5 tests; `cookbooks/actions.ts`, thin server functions that check the brand first with requireBrand; built-ins in `cookbooks/builtin/index.ts`). Rules: viewers read; members create and fork; a member edits or archives only their own cookbook; a copy of a built-in is maintained by an admin; built-in ids are reserved and cannot be archived.
- `cookbooks/actions.ts`: `listCookbooks`, `getCookbook`, `resolveCookbookFor` (no writes), `saveCookbook`, `forkCookbook`,
  `archiveCookbook`, each with `authMiddleware`, `requireBrand` and role checks (viewer reads; editor saves and forks their own; admin
  edits copies of built-ins, D5).
- Tests: each role on each action.

#### K8: Migrate the saved pipeline configs (D4)
- Status: `done` (`cookbooks/factory-bridge.ts`: a brand's saved factory line is also its cookbook, `ck_bf_<hash of the brand>`, with the preset as parent; loading prefers the cookbook and falls back to the old row; saving writes both, so the old table is still written until K20 retires it; `migrateFactoryPipelineConfigs` writes each old row once and is idempotent. Five PGlite tests: exact round trip for each preset, the factory's clamps still apply, one version for one line, another brand sees nothing, and the migration runs twice. The existing factory tests pass.)
- Each `factory_pipeline_configs` row becomes a brand cookbook (forked from its preset's built-in, with its saved values as defaults),
  and `loadFactoryPipelineConfig` reads through the cookbook. The old table stays, read only, until K20 moves its editor; the
  migration is idempotent.
- Tests (PGlite): a saved config round-trips to the same `FactoryPipelineConfig`.

### Stage 3: automatic selection with a person in the loop (D1)

#### K9: Eligibility from the inputs
- Status: `done` (`cookbooks/eligibility.ts`: each required ingredient must have a way available to this run; a coded way always, an upload when the person supplied that file, a paid way only with a budget above zero; the modes follow. Nine tests.)
- `cookbooks/eligibility.ts`, pure: from the request inputs, decide which cookbooks can run and why the others cannot. The inputs are:
  - the brief text and its length;
  - a reference video, and its Video DNA when cached;
  - a product kit;
  - uploaded footage or a voice recording;
  - the budget;
  - the run kind (normal or automated loop).
- Example: no presenter footage and no avatar budget rules out a UGC cookbook that requires one.
- Tests: one case per ingredient kind.

#### K10: The cookbook selector role
- Status: `partly done`. The logic is done in `cookbooks/selector.ts` (8 tests, with a fake port): the data sent (eligible cookbooks and inputs, delimited, no instructions), the answer's shape, each pick checked against the eligible list and its controls (a bad pick refuses the whole answer), and a port that is not connected gives the picker. The model call itself is a port. Registering the role `cookbook_selector` needs a value in `CLAUDE_ROLES` (engine-contracts), a database check migration, a prompt file and a role definition. That is a contract change beyond the approved cookbook field, so it is parked for the owner (Q34).
- A new Claude role, `cookbook_selector`. It uses a small model through `runRole` and the gateway, with a budget line in the ledger.
  - Its prompt is `src/engine/prompts/cookbook_selector@1.md`.
  - It receives the eligible cookbooks (id, label, summary, needs, controls) and the inputs as delimited data.
  - It answers with a ranked choice of up to three, starting values for the controls, and a one-line reason each, validated by zod.
- Fail closed: an answer naming a cookbook outside the eligible list, or a value outside a control, is refused. When the role is not
  connected, the result is `NOT_CONNECTED` and the screen asks the person to pick.
- Tests: recorded answers (a good pick, an ineligible pick refused, an out-of-range value refused, not connected).

#### K11: Selection in the request flow
- Status: `done` for the logic (`cookbooks/select.ts`, 5 tests): a normal run waits for the person; an automated loop accepts the top pick; a confirmed pick, a changed value, and an alternative are recorded as confirmed, changed and auto_accepted. Wiring it into the screen is K18.
- `cookbooks/select.ts`: `proposeCookbook(inputs)`, which runs eligibility, then the selector, then the resolver, and returns the
  proposal: the cookbook, the values, the requirements, the estimate, the reason and the alternatives.
- Normal runs: the proposal is shown and nothing is sent until the person confirms, optionally after changing the cookbook or
  its values.
- Automated loops: the proposal is accepted and recorded as `auto_accepted`.
- The chosen cookbook, its version, its values and how it was chosen (auto, auto-accepted, changed by a person) are stored with the run.
- Tests: both paths, and a changed choice recorded as changed.

### Stage 4: engine integration (contract approved by D1)

#### K12: Phase A wiring through existing fields
- Status: `done` (`content-factory/cookbook-request.ts`, 4 tests: a cookbook that names a style replaces the theme's kit, a factory preset leaves it, the length caps the request, the instructions join the brief or the change lines, and a brief over its limit is reported as incomplete in words. No contract change.)
- `content-factory/request.ts` `buildProductionRequest` takes a resolved cookbook and maps it onto existing fields: `page.styleKitId`
  (installed through `installStylePreset` or the kit store), `format.keep`, `visualRequests`, `constraints`, and a delimited
  "Cookbook instructions" section in `brief.text`.
- Tests: a request fixture for each built-in.

#### K13: Record the cookbook on runs (D6)
- Status: `partly done`. Done: migration `0141_content_factory_cookbook.sql` adds `cookbook_selection` to the content factory session, and `cookbooks/run-record.ts` writes it only while the run is a draft (3 PGlite tests: a draft records and reads back; a started run keeps nothing new; another workspace reads nothing). Remaining: copy the record onto the engine request's metadata, and include it in the export package (`distribution/export-package.ts`). Both are small follow-ups; the export follow-up is part of K30.
- The content factory run and the engine request record `cookbook_id`, `version`, the values, the mode and the selection kind
  (migration). The export package includes them.
- Tests (PGlite).

#### K14: `engine-contracts@12`
- Status: `done` (approved by D1, 2026-10-31). `productionRequestSchema` gains an optional `cookbook` (id, version, valuesHash, instructions per role; bounded, strict). `CONTRACTS_VERSION` is `engine-contracts@12`, the Bible section 4 note is written (the lead's review is still to be recorded there), and the request builder sets the field too. Six contract tests (v12), and all 299 engine contract tests pass.
- `productionRequestSchema` gains an optional `cookbook: { id, version, valuesHash, instructions: partial record of role to text }`.
  Optional, so earlier requests parse unchanged.
- Version bump in `contracts/version.ts`, and a migration note in Bible section 4 (`docs/engine/VIDEO_ENGINE_BIBLE.md`).
- Tests: v12 fixtures; a v11 request still parses; instruction text over the bound is refused.

#### K15: Roles that read cookbook instructions
- Status: `partly done`. Done: the script writer. `scriptwriter@3.md` is the version-2 text plus a section on the cookbook block (rule 11: the block sits under the rules and cannot lift a claim, a forbidden term, the copy rule, the length or a check). A run without a cookbook keeps version 2, byte for byte. A run with `cookbook.instructions.script` uses `scriptwriterWithCookbook` (version 3) and sends the block as escaped untrusted data. The write-script handler chooses the variant. Tests: the version-3 pin, the block's presence and escaping, the rule text, and the existing script writer and handler suites (28 pass). Remaining: the planner, the critic and the editor. Each needs its own `@n+1` prompt, a pin, and a role variant, following the same pattern.
- New prompt versions for the script writer, the planner, the critic and the editor (`<role>@<n+1>.md`) with a delimited "cookbook
  instructions" block, which is data and never overrides the rules or the gates. The roles pin the new versions; the old files stay
  unchanged (their hashes are pinned).
- Tests: the prompt hash pins for the new versions; recorded-answer tests show the block reaching each role; gates still fail a bad
  output whatever the instructions say.

#### K16: The orchestrator takes a cookbook as its plan template
- Status: `partly done`. Done: `cookbooks/plan-template.ts`. A cookbook's plan template becomes an orchestrator plan skeleton, validated by the orchestrator's own schema and in dependency order (every built-in: checked). An edit keeps the person's change and marks the node as edited (unknown steps are refused). A plan is sent only with the right selection: a confirmed one in a normal run, the auto-accepted one in an automated loop (3 tests). Remaining: the planner that fills in the models and prices (`orchestrator_plan@3`, with the skeleton as a constraint), and the send button, which is the screen's (K18).
- `engine/orchestrator/planner.ts` takes the resolved `planTemplate` as the starting plan; the person can still edit nodes on the
  canvas, and the plan records which nodes came from the cookbook.
- "Send to orchestrator" sends only after the selection step is confirmed (normal runs).
- Tests: a planner fixture per built-in; an edited node keeps its edit.

### Stage 5: screens

#### K17: The cookbook settings panel
- Status: `partly done`. The unsent draft is wired (14:57): `components/cookbooks/settings-draft.ts` keeps the draft per person, workspace and cookbook through `draft-store.ts`, saves it after a pause through `debounce.ts`, restores only the values that fit their controls, and drops the draft on discard or when it equals the defaults (6 tests). The panel itself is not mounted yet (K18). Done: the model (`src/components/cookbooks/settings-model.ts`, 4 tests: one row per control in order; a value of the wrong kind, out of range or not an option falls back to the default) and the panel (`settings-panel.tsx`: switches, sliders, selects, text and colour choices from the design system; typecheck and lint clean). NOT done: mounting the panel on a screen (K18), the browser check of its labels and keyboard use (ui-smoke, not run here), and the live update of the requirements (K18, through the resolver).
- `src/components/cookbooks/settings-panel.tsx`: renders any cookbook's controls from the schema with `Switch`, `Slider`,
  `SelectInput`, `RadioGroup` and the kit colour roles. Requirements and estimate update live through `resolveCookbook`.
- Accessibility: a label on every control, keyboard use, visible focus, reduced motion.
- `lib/create/steps.ts` (K0) is reused for the brief, plan and review step header if it fits.
- Tests: component tests for each control kind; a ui-smoke path.

#### K18: The selection step in the Content Factory
- Status: `partly done`. Done: the component `cookbook-selection-step.tsx` draws that view (the pick and its confirm button, the alternatives, the picker, the no-pick reasons, the failed and refused messages; typecheck and lint clean; not mounted yet). Also done: the view model `src/components/content-factory/cookbook-selection-model.ts` (4 tests): a proposed pick shows its title, reason, needs, badge, estimate (unknown parts named) and the alternatives; nothing eligible says why; a selector that is not connected offers the picker; a failed call and a refused answer are shown as what they are. Also done (22:45): `proposeFor` in `cookbooks/service.ts` (the library, checked against the run's inputs, then the selector through the port; two PGlite tests: no selector gives the picker, a port's pick is resolved) and the read-only server function `proposeCookbookAction` (viewer; the port is not connected, so the answer is the picker, until Q34). Remaining, split into three units (the integration points were found on 2026-10-31 23:10):
  - K18a (DONE 23:40): `content-factory/cookbook-choice.ts` (`chooseCookbookFor`, `runInputsOf`) reads the run's inputs from the session, checks the choice against the proposal or, with no selector, against the eligible list (the new `picked` record), and records it on a draft only; the server action `chooseCookbookForRunAction` is in `cookbooks/actions.ts`. 6 PGlite tests; the full content-factory suite passes (269). Original plan: a server action `chooseCookbookAction` (draft session only; the run's inputs are read from the session: the budget (`budget_usd`), the length (`max_seconds`), whether a reference is attached (`attachmentsOf`/`referenceOf` in `content-factory/request.ts`), the uploads, the brief's length), which recomputes the proposal with `proposeFor`, checks the choice with `confirmSelection`, and writes the record with `recordCookbookSelection`. PGlite tests: a draft records, a started run refuses, a choice outside the proposal is refused.
  - K18b (DONE 23:58): `applyRecordedCookbook` in `content-factory/cookbook-choice.ts` is called from `buildFor` in `service-run.ts`, so the start and the preview see the same request. A run with no record is unchanged; a recorded cookbook is resolved with the person's values and applied (its style, its length cap, its instructions, the `cookbook` reference). 2 new PGlite tests; content-factory and cookbook suites together pass (413). Original: `startRun` (`content-factory/service-run.ts`) applies the recorded cookbook to the request with `applyCookbook` and writes the record on the engine request. Tests: the existing service-run tests still pass; a run with a recorded cookbook carries `cookbook` on the request.
  - K18c (DONE 00:30, `24a2515`): the step is mounted in `DraftPanel` (`cookbook-choice-panel.tsx`, above "Make this video"). The server proposes from the session (`proposeCookbookForRunAction`), the picker and alternatives show labels, the confirm sends the top pick at its version, and the start waits while a pick or the picker has no recorded choice. 454 tests across the cookbook, content-factory and cookbook component suites pass; the look is for ui-smoke in CI. Original note: mount the step in `DraftPanel` (`src/components/content-factory/run-panel.tsx`, before `startContentFactoryRun`), with `CookbookSelectionStep`, the view from `selectionViewOf`, and the confirmed choice sent to K18a. ui-smoke covers the path; the browser check runs in CI. with the settings panel (K17), the draft save of the values through draft-store with debounce, and the browser check (ui-smoke).
- After the inputs, the hub shows the proposal: the pick with its reason, two alternatives, the settings panel, and the needs and
  estimate. The person can change the cookbook and adjust it, then press "Send to orchestrator".
- When the selector is not connected, the hub says so and shows the picker.
- The three start modes become the "blank" cookbooks (K5).
- Tests: ui-smoke covers pick, change and send.

#### K19b: The cookbook client code stops importing the engine (blocks K19's route and K20b1)
- Status: `done` (K19b3 `c972854`: `fitsControl` moved to controls.ts, re-exported by validate.ts; the settings model imports it from controls.ts; the release acceptance has a browser check H1 for `/brands/$brandId/cookbooks`, which passed locally: 31 of 31, no externalized-module error in the dev server log; CI runs it too). K19b2 done (`81fc9c5`): the card rules are in `cookbooks/cards.ts` (server), `libraryFor` returns the cards, and the screen draws them; `library-model.ts` keeps the plain filter and family helpers. K19b1 done (`ceb3b68`): the role list is `engine/contracts/cookbook-roles.ts` (zod only, re-exported by request.ts), and the family list is `lib/meridian/cookbooks/families.ts` (re-exported by schema.ts). Still true: the screen imports the server-function module `actions.ts`, which reaches the engine on the server side; the browser check shows that this does not crash the route. Found 03:4x UTC: the release acceptance crashed the Content page when the factory editor imported the cookbook library's client code. That code imports the engine contracts (`controls.ts` through `contracts/request.ts`, `resolve.ts` through `contracts/hash.ts`), and `contracts/ids.ts` and `hash.ts` use `node:crypto`, which the browser does not have. The K19 route (`/brands/$brandId/cookbooks`) imports the same client code, so it is probably broken in the browser as well; CI never opens it. To verify, load that route in a browser.
- Fix: the server computes the card rows (`cardOf` and `cardsOf` in the service, with the library response carrying them) and the settings rows and defaults for a detail. The browser code then imports only types and plain helpers (`estimateWords`, `familiesIn`, `nonFactoryCardsOf`), with no engine import. Then re-add K20b1.
- Also: add a browser check of `/brands/$brandId/cookbooks` to the acceptance, so this cannot pass unseen again.

#### K19: The cookbook library and detail screens
- Status: `done` (the version list is in: `listCookbookVersions` in the store and `versionsFor` in the service, with a store test and a service test; a built-in shows that it is versioned with the app. `library-model.ts`, 6 tests: a card per built-in, the explainer free in agent mode, the free and family filters, workspace copies after built-ins, unknown parts named). The route `/brands/$brandId/cookbooks` (`routes/_app/brands/$brandId/cookbooks.tsx`, the route tree regenerated) and the screen `library-screen.tsx` are in; the sidebar has "Cookbooks" under Create, with the navigation tests updated (51 tests across the cookbook and navigation suites pass). Left open on purpose: (b) "Use in Content Factory" goes to the Create section, not with a `?cookbook=` parameter, because the Content page drops unknown search keys; the run's Cookbook step (K18c) offers the cookbook there; (c) the repurpose catalog `packs` capability (deferred from K5) is still unavailable; (d) the look is not checked in a browser (CI ui-smoke only visits the other pages).
- Depends on: K7, K17.
- `/brands/$brandId/cookbooks`: cards with badge, needs and estimate; filters by family and "free in agent mode"; detail with the
  settings panel, "Use in Content Factory" (`?cookbook=`), "Save as my cookbook" (fork, brand or workspace, D3) and the version
  history.
- Navigation entry, with the navigation tests updated.

#### K20: The pipeline editor becomes the cookbook editor (D4)
- Note (10:2x UTC): K20f parked on Q37. The three pipeline-model cases test `engineRows` (the factory's engine picker). The cookbook model has no provider connection status (its eligibility covers footage and budget only), so the cases have no counterpart to move to, and the move would add a provider rule, which the loop does not make unasked. The cases stay where they are, passing, until the owner decides Q37 or K29 retires the picker. K20's other items are done.
- Note (09:5x UTC): K20e done (the cookbook form marks each refused field next to it). `fieldProblemsOf` in `edit-model.ts` checks each changed field alone, by the same rules, and returns the reason by the field's key (`control:<id>`, `instruction:<index>`, `step-label:<index>`, `step-param:<index>:<key>`). The form shows the reason under that field, and Save sends nothing while one is marked. The factory's generation and grading controls are sliders and choices bounded by their ranges, so no typed value can be refused there; the prompts panel already marks an empty prompt. That reading is Q36 (decided by loop, confirm). 20 edit-model tests (1 new); eslint and typecheck pass. The release acceptance passes locally, 32 of 32 (`ra-run12`); H2 now types a blank instruction and waits for its message, then saves a valid one. Not yet checked: the messages in a browser beyond that path. K20f (move the pipeline-model tests to the cookbook model, as the spec asks) is next to check.
- Note (09:3x UTC): K20d done (the form's step fields). `components/cookbooks/edit-model.ts` gains `editsFromDraft`, which turns the form's draft (control values, instruction texts, step names and settings) into the edits; an untouched draft makes none. The form (`cookbook-edit-form.tsx`) shows a Steps section after the instructions: a step name field (up to 80 characters) and one field per setting, shown by its kind (checkbox, number box, text box). Save runs the edits through the same rules and save plan as before. 19 edit-model tests (3 new in this unit); eslint and typecheck pass. The release acceptance passes locally, 32 of 32, and H2 now also checks that the step name field is visible in the browser (`ra-run11`). Not yet exercised: saving a changed step name or setting in the browser. K20e (inline validation on the generation and grading fields) is next.
- Note (09:0x UTC): K20c done (the rules for steps): `components/cookbooks/edit-model.ts` gains a step label rule (trimmed, 1 to 80 characters), a step setting rule (a key the step already has, a value of the same kind, the schema's own check on the value), and two edit kinds, `step-label` and `step-param`, that `applyEdits` applies to a copy. 16 tests in edit-model (3 new); eslint and typecheck pass. Not in a browser yet: the form does not show step fields. K20d (the form: a step's label and its settings, saved through the same plan) and K20e (inline validation on the generation and grading fields) are next.
- Note (08:4x UTC): the browser check of the Edit action is done. Acceptance check H2 (`scripts/release-acceptance/acceptance.mjs`) opens a built-in's steps on the Batch section's Factory Line tab, opens Edit, changes an instruction, and saves it as the person's copy ("Saved as your copy."). Local run ra-run10 (dev server, testing runtime): 32 pass, 0 fail, exit 0. Not covered: a save of a workspace cookbook (the single-save path) in a browser, and any live server. K20 stays `partly done`: the spec says the editor edits a cookbook's steps, which it does not do yet, and the generation and grading fields do not show validation next to the field yet.
- Note (08:1x UTC): the parent-link gap is fixed in the store: a later version of a copy keeps the parent its latest version recorded (one test on PGlite); the cookbook suites pass (188 tests).
- Note (07:4x UTC): K20b3 done (part 2c): the outline panel has an Edit action for members and above; the edit form (`components/cookbooks/cookbook-edit-form.tsx`) edits control defaults and instruction texts, and Save runs the rules and the save plan through `forkCookbookAction` and `saveCookbookAction`. The release acceptance passes locally (31 of 31). The Edit action is not clicked by the acceptance; its save path is not exercised in a browser here. The parent-link gap (a copy's later versions) is still to check in the store.
- Note (07:2x UTC): K20b3b part 2b done: the save plan's copy is saved as a workspace cookbook (its scope is set), and `runSavePlan` runs a plan through two injected calls (fork, save), stopping at the first failure, with the copy's state named when the edits are refused; 13 tests. Known gap: the copy's later versions do not carry the parent link the fork records (the save path does not pass it); to be checked in the store. Part 2c (the editor's fields and the call to these functions from the screen) is next.
- Note (06:58 UTC): K20b3b part 2a done: `planSave` in `components/cookbooks/edit-model.ts` turns an edited cookbook into the server calls that save it (a workspace cookbook: one save; a built-in: a fork to a `ck_my_` copy, then a save of the copy); 9 tests. Part 2b (the editor's fields for controls and instructions, and running the plan through `forkCookbookAction` and `saveCookbookAction`) is next.
- Note (06:35 UTC): K20b3b part 1 done: `applyEdits` in `components/cookbooks/edit-model.ts` applies a set of control-default and instruction-text edits to a copy of a cookbook, stopping at the first failure; 6 tests. Part 2 (the editor's fields, and saving through `saveCookbookAction`, which needs a copy first for a built-in cookbook, since admins maintain copies of built-ins (D5)) is next.
- Note (06:1x UTC): K20b3a done: `components/cookbooks/edit-model.ts`, the editor's rules: a control takes only a value that fits it (bounds, options, kind), and an instruction must say something and fit the 4000-character limit; 4 tests. K20b3b (the editor's controls and instruction fields, saved through `saveCookbookAction`, with the server checking again) is next.
- Note (05:5x UTC): K20b2b done: each cookbook in the preset bar has a Show steps button, which opens its outline (`components/cookbooks/cookbook-outline.tsx`, read through `readCookbookAction`). The release acceptance passes locally (31 of 31). The acceptance does not click the button; its rendering is not checked in a browser here.
- Note (05:2x UTC): K20b2a done: `components/cookbooks/outline-model.ts`, a pure read-only outline of one cookbook (steps in order with what each waits for and whether it is conditional; controls with defaults in words), with 3 tests. K20b2b (mount it in the editor, reading the cookbook through `readCookbookAction`) is next.
- Note (05:0x UTC): K20b1 is re-applied on top of K19b, and the release acceptance passes locally (31 of 31, including F1, F2 and H1). The K20b2 and K20b3 split stands.
- Status: `done, except K20f`. K20f (move the pipeline-model tests to the cookbook model) is `parked` on Q37: its three cases test `engineRows`, which has no cookbook-side counterpart, and the move would add a provider rule to the cookbook's eligibility. K20a (`commit below`): the factory line is saved as its cookbook only; `savePipelineConfig` and `applyPipelinePreset` no longer write `factory_pipeline_configs`, and a refused cookbook is an error (`saveFactoryLine`). One PGlite test; the factory and cookbook suites (515 tests) and typecheck and lint pass. Split of K20b (logged 02:5x UTC; one unit each): K20b1 (REVERTED in `d655807`, the Content page crashed in the browser; see K19b):  the preset bar lists the brand's other cookbooks as read-only entries (label, summary, badge) beneath the four factory presets, with one link to the cookbook library (not to Create: a link to Create would drop the cookbook, as the Content page keeps only its own search keys). The factory presets and blank modes are left out (`nonFactoryCardsOf`, one test). A library that cannot be read shows no list. Not checked in a browser. K20b2: the editor shows the cookbook's steps and controls read-only, with the pipeline-model cases moved to the cookbook model and kept. K20b3: the editor edits controls within their declared bounds and each role's instructions, saved through saveCookbookAction. Validation next to fields: the prompts panel already shows each empty prompt's problem beside its field (prompts-panel.tsx, the problem's message on the field). The same pattern extends to the generation and grading fields in K20b3; no separate unit. Depends on: K8, K19.
- `pipeline-editor.tsx` and `preset-bar.tsx` are upgraded, not replaced: the preset bar lists cookbooks, and the editor edits a
  cookbook's steps, per-role instructions (D5 roles) and controls. Validation errors show next to their fields.
- `factory_pipeline_configs` is no longer written; its rows were migrated in K8.
- Tests: the existing pipeline-model tests move to the cookbook model and keep their cases.

### Stage 6: components, agent mode and checks

#### K21: Compose components for data explainers
- Status: `done` (12:36: every component on the list is built and registered; their looks are not checked in a browser, since GSAP cannot load here). Done: `label.pill` (the place in a pill at the top of the frame, with the date after a dot when there is one; props, template, three fixtures, registered; no golden frames, as for stat.counter; components test 126 of 126, compose suite 299 of 299, eslint and typecheck exit 0, the inline script parses; the look is not checked in a browser). `captions.boxed` (this unit: the karaoke captions, with the spoken word in a filled box in the kit's highlight colour and the words to come dimmed; the same props and bands, its props reuse the karaoke caption schema; three fixtures; registered; no golden frames, as for stat.counter, because this sandbox cannot load GSAP from its CDN). Checks: components test 119 of 119, compose suite 289 of 289, eslint and typecheck exit 0, the template's inline script parses. NOT checked: how it looks, which needs a browser render. `stat.counter` (a number that counts up on the composition clock, with a pill label; props, template, three fixtures, registered; the library list is pinned in the components test, which now holds 17). The component contract tests pass (112), and every compose test passes (279). NOT verified here: how it looks. The templates load GSAP from a CDN, which this sandbox cannot reach, so the look needs the owner's render or the browser check. Remaining: none. `cta.follow` is done (12:36: a follow prompt pill with a handle, in the lower band at 66% of the frame, above the bottom 20% line; the prompt defaults to Follow for more; three fixtures; registered; the pinned list holds 21; components test 154 of 154, compose suite 339 of 339, eslint, typecheck and the inline script check pass; the look is not checked in a browser). `panel.tiles` is done (12:12: one to six tiles, each a short value and its label, in two, three or one column by count; the value colour is read from the kit; three fixtures; registered; the pinned list holds 20; components test 147 of 147, compose suite 329 of 329, eslint, typecheck and the inline script check pass; the look is not checked in a browser). `panel.line` is done (11:57: a line through two to twelve labelled points, drawn on the composition clock with a dot at each point, scaled to the largest value; the stroke colour is read from the kit; three fixtures; registered; the pinned list holds 19; components test 140 of 140, compose suite 319 of 319, eslint, typecheck and the inline script check pass; the look is not checked in a browser). `panel.bars` is done (11:33: up to eight labelled bars that grow on the composition clock in proportion to the largest value; the accent colour is read from the kit; three fixtures; registered; the pinned list holds 18; components test 133 of 133, compose suite 309 of 309, eslint, typecheck and the inline script check pass; the look is not checked in a browser).
- One component per unit, each with `props.ts`, golden snapshots and declared variables in the K1 schema:
  - `captions.boxed` (in the contract already; the spoken word in a filled box, the words to come dimmed);
  - `stat.counter` (a number that counts up, with a pill label);
  - `label.pill` (place and date);
  - `panel.bars`, `panel.line` and `panel.tiles` (data panels in the room style);
  - `cta.follow`.

#### K22: The checks module
- Status: `done except the Q32 move` (13:01). Done: `cookbooks/checks.ts` (pass, near, miss, unknown; an unreadable measure is never a pass; a plain report line per check; 3 tests). The measures are wired (13:01): the derivation of the compare report moved from `scripts/engine/preset-preview/compare.ts` into `src/engine/analyze/measures.ts` (`measuresOf` takes the media functions' readings, and `numericMeasures` keeps what a check can compare). The script now gathers the readings and calls it, and an unknown duration or loop distance stays null (the old script crashed on a zero duration). 7 tests on recorded readings, the checks test feeds recorded measures to a check by name; eslint and typecheck pass. The script was not run end to end, since no reference video is in the repository. Parked: the safe-zone move into the post-render gate, which is Q32's decision (the loop recommends option a).
- `cookbooks/checks.ts`: measure an output with the media functions and compare it with the cookbook's targets (pass, near, miss).
  It generalises `scripts/engine/preset-preview/compare.ts`.
- The safe-zone check from `gates/slop-craft-gates.ts` moves here and into the engine's post-render gate as a note (Q32, option a). The
  rest of that file is retired after its tests move.
- Tests: recorded measures.

#### K23: The agent-mode renderer
- Status: `parked` on Q39 (13:23): the explainer's 3D room and scenes are not in the component library, so the renderer needs the owner's choice of how they are drawn; and no frame can be checked here, since the templates load GSAP from a CDN this sandbox cannot reach. Depends on: K4, K21, K22.
- `scripts/engine/cookbook-render/`: generalises `scripts/engine/preset-preview/` to read a resolved cookbook and draw it with the K21
  components and the shader scenes, frame by frame, in the local Chromium, and to run the K22 checks on the result. No provider is
  called.
- The preview script stays as a thin wrapper.
- Done when: the 3D data explainer renders from its cookbook and its check report is in the run log.

#### K24: A cookbook as a Claude Code skill
- Status: `pending`. Depends on: K23.
- `.claude/skills/cookbook-video/SKILL.md` and an export function: a session makes an agent-mode video from any cookbook that allows
  agent mode (script, scenes, render, checks), with the hard stops above.
- Agent-mode videos enter review with the label "made in agent mode" and pass the same disclosure and publish gates (D2).
- Tests: the export for each built-in; the label reaches the review item.

#### K25: From a reference video to a draft cookbook
- Status: `parked` on Q40 (13:23): the remaining beats and genome need the paid Video DNA analysis, and spending on it is an owner decision. Done: `cookbooks/from-reference.ts`. From a reference's measures it writes a valid draft: the measured numbers become the checks, what was not measured is listed as unknown (structure, style, instructions, ingredients), and the draft stays engine-only until reviewed (3 tests, built from the 3D explainer's recorded measures). Remaining: the beats and the genome, when the Video DNA exists (the paid analysis), and the labels that say which values were read from frames rather than measured.
- `cookbooks/from-reference.ts` automates what was done by hand on 2026-10-31. From a reference's free measures (media functions),
  and its Video DNA when the paid analysis has run, it writes a draft cookbook: kit, layout, grammar targets, cut rule, structure and
  gaps.
- Values that were read rather than measured are labelled `read`, and unknown stays unknown.
- Tests: the 3D explainer's recorded measures give a draft that validates and matches K4's grammar targets.

### Stage 7: more built-ins, learning, finish

#### K26: A UGC product cookbook
- Status: `done` (`cookbooks/builtin/more-built-ins.ts`: the presenter (AI, paid, or the person's footage, free), the product kit, product shots, an end card, and a hook parameter; the AI presenter and product shots turn agent mode off; 4 tests in `more-built-ins.test.ts`).
- Ingredients: presenter (avatar, paid, or upload); product kit (required).
- Options: hook type, product shots, presenter, captions.
- Tests: the badges and modes for each presenter choice.

#### K27: A voice-led listicle cookbook
- Status: `done` (the same file: the voice (AI, priced per character so unknown until counted, or the person's recording, free), kinetic type (coded) and optional stock clips (paid, turn agent mode off); the default recording runs free).
- Ingredients: voice (AI voice, paid, or my recording); kinetic type and stock.
- Agent mode is allowed with a recording.

#### K28: Results by cookbook and option (D6)
- Status: `parked` on Q41 (13:48): the export file waits for stored measures. Done: the store read (`cookbooks/recorded-runs.ts`, 3 PGlite tests: a run's cookbook, version, values and choice; unreadable records counted; another workspace not read) and the export builder (`resultsExportOf` in `cookbooks/results.ts`, 1 test, which says when no measure is recorded). Earlier: `cookbooks/results.ts`, a pure table of recorded runs by cookbook, version and setting. A missing measure is counted as unknown, never 0; one run is marked as one; the table does not depend on the order of the runs (4 tests). Remaining: reading the runs from the store (the session records of K13, joined with the measures of the published output), and the export file next to `docs/data/`. The table makes measurements and counts only, not scores (AGENTS rule 9).
- `learning/cookbook-results.ts` and a view: results per cookbook, version and option value, from recorded runs and their published
  measurements, with unknowns as unknown, plus an export for the research agents next to `docs/data/`.
- Scores stay scores until a calibration report says otherwise.

#### K29: Retire what the cookbooks replaced (D4)
- Status: `pending`. Depends on: K20, K22, K24.
- Remove only what is now covered: the unused `flow/nodes.ts` and `flow/connector.ts`, after their node kinds and tests are checked
  against cookbook steps (Q21); the old pipeline preset constants, after K5's equivalence tests pass; and the rest of
  `slop-craft-gates.ts`, after K22.
- Tests: the full suite keeps its counts, minus the removed tests, which are listed in the log.

#### K30: Owner guide and the pull request
- Status: `pending`. Depends on: every task above, apart from parked ones.
- Write `docs/COOKBOOKS.md`, a guide in plain words: picking, changing, saving and sharing cookbooks, what each badge means, agent
  mode against engine mode, and what the owner's live steps are (the selector's first live call, a paid render).
- Refresh the PR description, and run the release acceptance and a browser pass over the new screens.
- Then end the run (the skill's End of run).
