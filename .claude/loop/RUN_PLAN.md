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
- Status: `active`, 6 of 45 wired so far: the export package and the disclosure gate (R4), the discovery provenance (`discovery/provenance.ts`, shown as "Where it was seen" on each stored Market page, read-only, brand-scoped), the engine alerts (`ops/alerts-sql.ts`, shown as "Alerts right now" on `/engine-ops`, Q14), the batch planner (`ops/batch.ts`, shown as "Batch requests" on `/engine-ops`, Q15), and the concurrency proposals (`ops/concurrency.ts`, shown as "Concurrency proposals" on `/engine-ops`, held at every size until calls record their bucket, Q16). The owner's answer to Q3 is to make each one work, or to say clearly why it cannot. The four learning modules (`fatigue`, `guardrails`, `organic-telemetry`, `parameters`) are explained, not wired: wiring each one changes learning, scoring or product direction, so each waits for the owner (Q17). `studio/loop.ts` and `study/deep-study-service.ts` are explained, not wired (Q18): the loop runs on test providers, and the deep study depends on model-backed JEV judgment, so wiring either one would show fixture output as real or start model calls. `production/route.ts`, `production/rework-engine.ts` and `production/voice-director.ts` are explained, not wired (Q19): approval routing is a decision for you, the rework engine needs the footage-rights decision from R4 and has a placeholder music asset, and the voice plan needs a voice vendor and consented voices. `jobs/durable.ts` (an in-memory queue, a second one next to the Postgres worker) and `video/scene-frames.ts` (a second frame selector, next to the one image QC uses) are explained, not wired (Q20): wiring either would build a parallel pipeline or change every visual judgment, and deleting them is the owner's decision. `flow/nodes.ts` (a second pipeline with the same stages as the Factory) and `grading/priors.ts` (labelled seed priors that scoring would use) are explained, not wired (Q21): wiring the first would build a parallel pipeline, and wiring the second changes scoring before a calibration report exists. `intelligence/cluster.ts` (a second clustering, next to the one in `intelligence/whitespace.ts` that the opportunity engine uses) and `jev/calibration.ts` (a second Brier and log-loss, next to the calibration reports the product uses) are explained, not wired (Q22): both duplicate product code, and deleting them is the owner's decision. The `organic/*` group (eight files: the Instagram creator, reel and comment modules, and their learning bridge) is explained, not wired (Q23): its entry point, `factory/instagram-volume.ts`, asks Apify for about 1,000 reel candidates per niche per week, which is paid spend and needs the owner's approval, and the learning bridge writes into learning, which is scoring. Nothing in the product calls the group. `quality/evidence.ts` (freshness labels no screen shows yet) and `shopify/reel-attribution.ts` (tracked reel links, which the publish step should call) are explained, not wired (Q24): the first is a display choice, and the second changes every published reel's link, which is an outward change for you to approve. `calibration/report.ts` is a third calibration implementation with no caller, next to `learning/calibration-report.ts` (which the calibration screen uses) and `jev/calibration.ts` (Q22). It is explained, not wired (Q25). `discovery/provenance.ts` is wired (17:52): `itemProvenanceFor` checks brand access the way `listDiscoveredItemsFor` does, `getDiscoveredItemProvenance` exposes it, and each stored Market page has a "Where it was seen" disclosure that loads on open. Tests: `provenance-view.test.ts` (1 of 1, PGlite). The existing `source-provenance.test.ts` still passes (3 of 3). Browser check of the Market page: CI's `ui-smoke` job, not run here. The rest of the feature-code list in section 6A of `docs/STATE_2026-10-28.md` is next. `storage/filesystem.ts` (a local-disk object store on the engine's object-store port, next to the Drive-backed store) and `vision/logo.ts` (a second logo matcher next to `vision/measure.ts`, which image QC uses) are explained, not wired (Q26): a second storage backend is a storage-location decision, and the second logo matcher duplicates the one in use. `a11y/contrast.ts` is not dead code: `src/components/ui/tokens.test.ts` uses it to check the theme's contrast ratios, so it guards accessibility (AGENTS rule 11) and needs no change. `factory/cost.ts` (a stage-cost rollup and a budget check) has no caller at all, and wiring it adds a spend check, which is the owner's decision (Q27). `factory/render.ts` (a timeline builder with no caller, whose clips come from the fixture helpers in `video/inspect.ts`) is explained, not wired (Q28): wiring it would make fixture clips look like a render. `factory/benchmark-harness.ts` is in use by its own test (`benchmark-harness.test.ts`), which checks the opportunity ranking against a hand-labelled gold set, so it needs no product change (the same treatment as `a11y/contrast.ts`). The four engine modules are explained, not wired (Q29): `engine/jobs/review-decision.ts` writes engine approval decisions (with `engine/review/labels.ts` and `engine/review/take/gold.ts`, which only it uses), so wiring it changes approvals; `engine/assets/firstLastFrame.ts` is a frame test that would call paid video providers, so it needs the owner's spend approval; `engine/render/recorded.ts` is a fixture of recorded render replies that neither the E1 script nor the product uses. `gates/slop-craft-gates.ts` is explained, not wired (Q32): four of its inputs (morphing faces, garbled text, plastic skin, robot voice) have no measurement in Meridian, so wiring it would feed it guesses; its loudness check duplicates the engine's post-render gate, and its flicker check duplicates the render-integrity detector. Its safe-zone check is the one part worth keeping. Still on the list after this: `lib/progress/*`, `lib/create/steps.ts`, `components/settings/connection-state.ts` and `render/splice-run.ts` (documented, not built). Each is checked with exact import patterns first. Each module is either wired into a product path, or it is explained in plain words as one that cannot be made to work
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
- Status: `done` (migration `0140_cookbooks.sql`; `cookbooks/store.ts`: save the next version, latest visible version, list, fork and archive; 8 PGlite tests: immutable numbered versions, brand and workspace visibility, a kept brand, forks with parents, archived-but-resolvable, reserved built-in ids, another workspace not found, and a body validated on the way in).
- Migration `migrations/0140_cookbooks.sql`. Columns: `id`, `organization_id`, `brand_id` (null when visible to the whole
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
- Status: `pending`. Depends on: K11, K14.
- `engine/orchestrator/planner.ts` takes the resolved `planTemplate` as the starting plan; the person can still edit nodes on the
  canvas, and the plan records which nodes came from the cookbook.
- "Send to orchestrator" sends only after the selection step is confirmed (normal runs).
- Tests: a planner fixture per built-in; an edited node keeps its edit.

### Stage 5: screens

#### K17: The cookbook settings panel
- Status: `pending`. Depends on: K1, K3.
- `src/components/cookbooks/settings-panel.tsx`: renders any cookbook's controls from the schema with `Switch`, `Slider`,
  `SelectInput`, `RadioGroup` and the kit colour roles. Requirements and estimate update live through `resolveCookbook`.
- Accessibility: a label on every control, keyboard use, visible focus, reduced motion.
- `lib/create/steps.ts` (K0) is reused for the brief, plan and review step header if it fits.
- Tests: component tests for each control kind; a ui-smoke path.

#### K18: The selection step in the Content Factory
- Status: `pending`. Depends on: K11, K17.
- After the inputs, the hub shows the proposal: the pick with its reason, two alternatives, the settings panel, and the needs and
  estimate. The person can change the cookbook and adjust it, then press "Send to orchestrator".
- When the selector is not connected, the hub says so and shows the picker.
- The three start modes become the "blank" cookbooks (K5).
- Tests: ui-smoke covers pick, change and send.

#### K19: The cookbook library and detail screens
- Status: `pending`. Depends on: K7, K17.
- `/brands/$brandId/cookbooks`: cards with badge, needs and estimate; filters by family and "free in agent mode"; detail with the
  settings panel, "Use in Content Factory" (`?cookbook=`), "Save as my cookbook" (fork, brand or workspace, D3) and the version
  history.
- Navigation entry, with the navigation tests updated.

#### K20: The pipeline editor becomes the cookbook editor (D4)
- Status: `pending`. Depends on: K8, K19.
- `pipeline-editor.tsx` and `preset-bar.tsx` are upgraded, not replaced: the preset bar lists cookbooks, and the editor edits a
  cookbook's steps, per-role instructions (D5 roles) and controls. Validation errors show next to their fields.
- `factory_pipeline_configs` is no longer written; its rows were migrated in K8.
- Tests: the existing pipeline-model tests move to the cookbook model and keep their cases.

### Stage 6: components, agent mode and checks

#### K21: Compose components for data explainers
- Status: `pending`. Depends on: K1.
- One component per unit, each with `props.ts`, golden snapshots and declared variables in the K1 schema:
  - `captions.boxed` (in the contract already; the spoken word in a filled box, the words to come dimmed);
  - `stat.counter` (a number that counts up, with a pill label);
  - `label.pill` (place and date);
  - `panel.bars`, `panel.line` and `panel.tiles` (data panels in the room style);
  - `cta.follow`.

#### K22: The checks module
- Status: `pending`. Depends on: K2.
- `cookbooks/checks.ts`: measure an output with the media functions and compare it with the cookbook's targets (pass, near, miss).
  It generalises `scripts/engine/preset-preview/compare.ts`.
- The safe-zone check from `gates/slop-craft-gates.ts` moves here and into the engine's post-render gate as a note (Q32, option a). The
  rest of that file is retired after its tests move.
- Tests: recorded measures.

#### K23: The agent-mode renderer
- Status: `pending`. Depends on: K4, K21, K22.
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
- Status: `pending`. Depends on: K4, K22.
- `cookbooks/from-reference.ts` automates what was done by hand on 2026-10-31. From a reference's free measures (media functions),
  and its Video DNA when the paid analysis has run, it writes a draft cookbook: kit, layout, grammar targets, cut rule, structure and
  gaps.
- Values that were read rather than measured are labelled `read`, and unknown stays unknown.
- Tests: the 3D explainer's recorded measures give a draft that validates and matches K4's grammar targets.

### Stage 7: more built-ins, learning, finish

#### K26: A UGC product cookbook
- Status: `pending`. Depends on: K4.
- Ingredients: presenter (avatar, paid, or upload); product kit (required).
- Options: hook type, product shots, presenter, captions.
- Tests: the badges and modes for each presenter choice.

#### K27: A voice-led listicle cookbook
- Status: `pending`. Depends on: K4.
- Ingredients: voice (AI voice, paid, or my recording); kinetic type and stock.
- Agent mode is allowed with a recording.

#### K28: Results by cookbook and option (D6)
- Status: `pending`. Depends on: K13.
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
