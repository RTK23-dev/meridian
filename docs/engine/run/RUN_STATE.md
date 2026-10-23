# Run state

Single loop, lead only, no subagents (owner, 2026-10-20). Branch `run/factory-6h`, built from `main`. Work is pushed between blocks.
Governing plan: `REPLAN_2026-10-20.md`.

## Log

- 2026-10-20 22:36Z. Preflight: Claude Code 2.1.304. `CLAUDE_CODE_EFFORT_LEVEL` and `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` not set. No `OPENROUTER_API_KEY` in the environment. OpenRouter public listings reachable (200).
- 2026-10-20 22:36Z. Recorded the live catalog snapshot (585 entries).
- 2026-10-20 22:40Z. Merged `claude/nice-tesla-zrf6un` into `run/factory-6h`. No conflicts. Gates on the merge: `npm test` 5617 tests (5576 pass, 0 fail, 41 skipped) before the orchestrator commit; typecheck exit 0; lint 0 errors.
- 2026-10-20 22:41Z. Orchestrator core written: contracts, catalog, validate, dirty, execute, layout, replay, canvas component. Orchestrator tests 52 of 52 pass; typecheck exit 0; lint exit 0 on new files.
- 2026-10-20 23:1xZ. Full `npm test` on the merged tree with the orchestrator: exit 0. Main suite 5700 tests (5659 pass, 0 fail, 41 skipped, env-gated). Script tests 160 pass. Typecheck exit 0. Lint 0 errors, 4 pre-existing warnings.
- Committed `e514b53` and pushed `run/factory-6h` to origin (new branch).
- 2026-10-20 23:0xZ. Pushed `cf60a33` (run state).
- 2026-10-20 23:2xZ. Planner added (`planner.ts`): asks the orchestrating model for a plan, treats the reply as untrusted, validates it against the live catalog; no plan on any failure. Recorded example run added (`example.ts`, stored as `fixtures/example-events.ts`, checked by test). Screen and route added: `/orchestrator` (recorded example, no provider called).
- Browser check of `/orchestrator` on the dev server (auth off, dev user): no console errors; no horizontal overflow at 390px; screenshots in the session scratchpad.
- Attempted: remove the fixed media fallback ids from `routes.ts` (Kling, Veo lite, Seedream 4.5, ElevenLabs v4, Gemini TTS). Reverted: 35 tests assert those fallbacks through adapters, so the change needs the adapters to take the live choice explicitly. That is the next block, not a one-line edit.
- 2026-10-20 23:5xZ. Pushed `bf7854e` (planner, recorded example, `/orchestrator`). Full suite on that tree: 5711 tests, 5670 pass, 0 fail, 41 skipped, exit 0. Lint exit 0 (0 errors, 4 pre-existing warnings). Typecheck exit 0.
- Status page published (private, no wake subscription registered): https://claude.ai/artifact/1szjYSNUowxC2ozQkK7ygD
- 2026-10-21. Removed the fixed media model ids from `routes.ts`: Kling (`video.cinematic`), Veo 3.1 Lite (`video.budget`), Seedream 4.5 (`image.keyframe`), ElevenLabs v4 and Gemini TTS (`tts`). What makes this safe: `gateway.chosen(capability, modelId)` routes a live-catalog choice; the video profile loader reads every model the live listing names instead of the table's; the chooser's fallback is the first eligible catalog candidate instead of the table's model; a chooser with no candidate leaves the call out (`no model for <class>`). Tests moved to explicit live ids or to a test table that names them. Affected set: 282 of 282 pass. Full suite: see the next entry.
- 2026-10-21. The orchestrator prices plans from the live catalog, not from the plan. The catalog snapshot now carries prices (text per token, image per image, video per second at 1080p). `validatePlan` computes each paid step's cost from its model's price and returns the checked plan; the plan's own `estimateUsd` is overwritten. A step with no price basis for its model (no per-image price, no per-second price, missing seconds or characters) does not run.
- 2026-10-21. The planner's live path is blocked by a migration and a contract change, written up for the owner in `docs/engine/run/PROPOSED_MIGRATION_ORCHESTRATOR_ROLE.md`: the role names are enforced by CHECK constraints in migrations 0081 and 0100.
- 2026-10-21. Offline plan editor on `/orchestrator`: pick a paid step, change its seconds, characters, output tokens or model from the recorded catalog. The page shows the engine's new cost, the steps that would run again (drawn dashed and labelled "To re-run"), or the refusal reasons. Browser-checked: 8 s gives $1.6846 and four steps to re-run; 90 s is clamped to 60 s and refused over budget; no console errors. The canvas draws the whole plan while an edit is open.
- Known limit: the canvas is wider than the screen, so the stale steps can be off to the right and need a scroll. Not fixed yet.
- Still fixed: the three Claude role models (`llm.direction`, `llm.analysis`, `llm.check`) and the Deepgram `nova-3` model in the stt route. The Claude roles are the production LLM path; changing them needs the owner's cutover decision (where the user's orchestrator choice is stored).

## Current state

| Area | State |
|---|---|
| Orchestrator core (plan, validate, surgical edits, executor, layout, replay) | Built and tested with fixtures |
| Live catalog | Recorded 2026-10-20; the runtime reads it through the gateway |
| Fixed model ids in the legacy pipeline (`routes.ts`) | Media ids removed; the three Claude roles and the Deepgram model id remain |
| Canvas on a screen | Component built; not mounted |
| Live runs | Not run: no key in the environment |
| Browser check | Not done |

## Blocked on the owner

- An OpenRouter key in the environment, with a hard credit limit set on the OpenRouter side. That is the only way the live steps can run.
- Open decisions in the Bible 20.2 list, and the storage, Veo and Hypit conflicts in `CLAUDE.md`.

## Pushed head a2a0dc1 (2026-10-21)

- Full suite on the pushed tree: 5716 tests, 5675 pass, 0 fail, 41 skipped (environment-gated), exit 0. Typecheck exit 0. Lint 0 errors.
- Status page (private, version 2): https://claude.ai/artifact/1szjYSNUowxC2ozQkK7ygD
- Still open, in order: (1) the owner's OpenRouter key in the environment, then recorded live calls with ledger and OpenRouter usage matched; (2) approval of the orchestrator role contract and migration (`PROPOSED_MIGRATION_ORCHESTRATOR_ROLE.md`); (3) the Claude role models and the Deepgram id out of the route table, after the cutover decision; (4) a plan store and Factory API route; (5) surgical re-render through the compose and render steps; (6) canvas fit-to-width so stale steps are on screen without scrolling.

## Block: planning service, live catalog reader, plans UI (2026-10-21)

- `ef0152e`: role `orchestrator_plan` approved and migrated (`0108_orchestrator_plans.sql`: role check widened; `orchestrator_plans`, `orchestrator_plan_events`, `orchestrator_step_outputs`). Plan store, stored-plan runner with spend carried across runs, and the stored-plan edit. Organization-scoped throughout.
- `c82d871`: planning service (`service.ts`: a request row, a reservation holding the call and its retry, then the Claude client with the chosen model and its live price); live catalog reader (`live-catalog.ts`, through the gateway, not_connected without a key); server functions in `src/lib/meridian/orchestrator/actions.ts`; plans section on `/orchestrator`.
- `33ebfb7`: the canvas fits its width (scale 1 down to 0.5, scrolls beyond); stored plans draw their canvas and offer the per-step editor.
- Gates on `33ebfb7`: full suite (run on the tree before this commit; the only later change is two UI component files that no test imports): 5750 tests, 5709 pass, 0 fail, 41 skipped (environment-gated), plus 160 script tests pass; exit 0. Typecheck exit 0. Lint 0 errors, 4 pre-existing warnings. `npm run build` exit 0.
- Browser check on the dev server: the recorded example fits the 1280px viewport at the half-size minimum and scrolls the rest; text is small at that scale. No console errors; no horizontal page overflow at 390px. Not checked: the stored-plan view. The dev database has no brand, so the plans section shows "Create a brand first".
- Still open: production step handlers are empty (`PRODUCTION_STEP_HANDLERS = {}`), so every step reports not_connected. Filling them needs the output shape of each step kind (a contract change, lead approval) and a decision on how the Claude roles take the orchestrator's chosen model. The three Claude role models and the Deepgram id remain fixed in `routes.ts` until that cutover.
- Still open: plan events are polled, not streamed; the model field is typed and validated at plan time, not picked from the live text list; surgical re-render through compose and render is not built.

## Block: orchestrator model stored in the Content Factory panel (2026-10-21)

- The workspace's orchestrator model is stored (`migrations/0109_orchestrator_settings.sql`, one row per workspace). Every plan that names no model uses it. The plan's own record still names the model that wrote it.
- The Content Factory screen has an "Orchestrator model" panel (admin only, like the screen). When the live catalog is connected, it lists the text models with prices; the save is refused for anything else. When it is not connected, the id is saved as typed, shape-checked, and the panel says it is not checked yet. The plan checks it when the plan is written.
- The hard-coded default model id in the plans form is gone. `/orchestrator` shows the stored model, or says none is stored and disables planning.
- Server functions: `getOrchestratorModelSetting`, `saveOrchestratorModelSetting`, `listOrchestratorTextModels` (admin, workspace), `getBrandOrchestratorModel` (viewer, brand). `createOrchestratorDraft` takes no model and uses the stored one.
- Tests: `src/engine/orchestrator/settings.test.ts` (8 pass: id shape, text models with both prices, store isolation between workspaces, replace, clear, refusal keeps the stored model).
- Gates: full suite 5758 tests, 5717 pass, 0 fail, 41 skipped (environment-gated); script tests 160 pass; exit 0. Typecheck exit 0. Lint 0 errors, 4 pre-existing warnings. `npm run build` exit 0.
- Not browser-checked. The local dev database has no workspace for the dev user, and creating one fails on a foreign key (the user row is missing). I did not seed auth tables to get around it.
- Live catalog: not read. No `OPENROUTER_API_KEY` is set in this environment. A key pasted into the chat is not used: it is now in the transcript, so it should be rotated, and the new key added as an environment secret named `OPENROUTER_API_KEY`.

## 2026-10-22, production handlers and run budget

- Done: step bodies (migration 0110), run reservation (`run-budget.ts`), text production handlers (`production.ts`: reference, analysis, script), failed-hold accounting. Decisions D1 to D5 in `DECISIONS_2026-10-22.md`.
- Still open: handlers for visual, voice, video, avatar, edit, compose and render; re-render wiring; every live run (no key in this environment); the Content Factory standalone page phases.
- The earlier note that production handlers are empty is superseded for reference, analysis and script.

## Run 2026-10-23: soft budgets, delegated category budgets, model brief, Veo off

Governing plan: `REPLAN_2026-10-23.md`. Decisions: `DECISIONS_2026-10-23.md`. Branch `run/orchestrator-budgets-2026-10-23`, from `origin/main` 19223045.

- 2026-10-23. B0 setup: worktree and `npm ci --ignore-scripts`. Run plan and decisions committed and pushed (`8b619aa2`).
- 2026-10-23. B1 Veo off and the model policy, done on fixtures.
  - `src/engine/config/model-policy.ts`: the initial disabled families (`google/veo`), prefix matching, aliases and case ignored.
  - `src/engine/gateway/catalog-policy.ts`: the policy applied on every catalog read (the families are read per call, so a Settings change is immediate). Removes the family from the entries and from the video listing.
  - `migrations/0114_orchestrator_policy.sql`: one JSON policy row per workspace (additive). `src/engine/orchestrator/policy-store.ts` validates every read and write; a missing key takes its initial value; a malformed row falls back to the initial policy as a whole.
  - The orchestrator's catalog (`api.ts`) drops the switched-off family before the orchestrator is shown or checks a plan. `validatePlan` names the policy as the reason (`listingReason`). The family list is threaded through `planWithRole`, `runStoredPlan` and `editStoredPlan`.
  - `src/engine/jobs/runtime.ts`: the engine's catalog source is wrapped with the policy (the reviewer's pick and the router's chooser read the same filtered catalog).
  - Tests: `model-policy.test.ts`, `catalog-policy.test.ts`, `policy-store.test.ts` (PGlite), `validate-policy.test.ts`. The B1 set passes (67 tests), the migration and store suites pass (36), typecheck exit 0, eslint exit 0 on the changed files.
- 2026-10-23. B2 soft budgets, done on fixtures.
  - `src/engine/budget/tolerance.ts` (pure): the tolerance is the larger of a percentage of the target and cents; the allowance is the target plus it; `budgetPosition` (within target, within tolerance, needs approval); `mayStart`; rounding up to a hundredth of a cent.
  - Brief path: `reserve`, `reserveFixed` and `extendReservation` admit a hold inside the allowance; cap mode refuses only past it; the reservation stores its allowances (contract field, additive) and they persist through migration `0115_engine_reservation_allowances.sql` and the SQL ledger store. A call that overruns its hold inside the allowances is authorized and the hold raised. A reservation with no budget fails closed on an overrun.
  - Orchestrator: `envelope.ts` (target = the lower of the plan budget and the set budget; allowance = target plus tolerance; a plan that asks for more is a note, not a refusal). `validatePlan` reports the plan's position and no longer refuses it on budget. The executor pauses at the step that would pass the allowance, waiting for an approval. The planning call is held against the allowance. The run reservation is the remaining allowance, and the month check uses the month's allowance.
  - Tests: `tolerance.test.ts`, `tolerance-admission.test.ts`, and the strict-boundary cases pinned to a zero tolerance. The orchestrator, budget, store and migration suites pass (327 at the last run), the job, gateway, asset and ops suites pass (888), typecheck exit 0, eslint exit 0 on the changed files.
- 2026-10-23. B3 category budgets and delegation, done on fixtures. Decision D8 in `DECISIONS_2026-10-23.md`.
  - The brief takes three optional budgets: `copyBudgetUsd`, `creativeBudgetUsd`, `voiceBudgetUsd` (`orchestratorBriefSchema`). The plan schema is unchanged (D4). `createOrchestratorDraft` accepts them, and an unset category is left out of the brief, so the orchestrator splits it.
  - `categories.ts` (pure): copy is analysis and script, creative is visual, video and avatar, voice is voice. A step with no model call has no category. A test checks that a step has a category exactly when it is paid.
  - `envelope.ts`: `envelopeAt`, `categoryEnvelopesOf` (a category the brief does not set has none), `allowancesOf`. Each set category uses the total's tolerance.
  - `validate.ts`: sums each set category's estimates and reports its position on the checked result. Past the allowance the plan is still a plan.
  - `execute.ts`: `categoryAllowanceUsd` and `categorySpentUsd`. A paid step that would pass its category's allowance pauses the run before it starts. The total is checked first. A charged, queued or held step counts toward its category.
  - Across runs: `orchestrator_step_outputs.category` (migration `0116_orchestrator_output_category.sql`). `run.ts` totals each category from the stored outputs and from the failed holds of its steps (`store.ts`: `outputsSpentByCategory`, `failedHoldsByNode`). The asset poll stores a settled video's output as creative.
  - The run refuses a stored brief that does not match its contract, rather than guessing its category budgets. Two fixtures stored `{}` and `{ goal: "g" }` briefs, which planning never stores (`checkPlanCall` refuses them): `run.test.ts` and `run-budget.test.ts` now store valid briefs. This is a fixture correction, not a change to a check.
  - The prompt is `orchestrator_plan@3.md`, and the role's `prompt.version` moves to 3. It names the split (rule 8). It also corrects rule 7: v2 said a plan the engine prices over budget "does not run", which is the exact-cap rule the owner replaced. Under the soft limit the run pauses at the step that passes the allowance.
  - Tests: `categories.test.ts`, `envelope.test.ts`, `validate-categories.test.ts`, `execute-categories.test.ts` (pure); `run-categories.test.ts` (PGlite: the pause at the second copy step, its stored output's category, a re-run that counts the stored copy money and pauses again without calling the step, delegation with no copy budget, the bad-brief refusal). Additions to `store.test.ts` (category round trip, totals per organization, failed holds), `asset-poll.test.ts` (a settled video is creative), `planner.test.ts` (the prompt states the split) and `orchestrator_plan.test.ts` (v3, the optional fields).
  - Gates: the orchestrator, role and prompt suites pass (209 tests, 0 fail). Typecheck exit 0. Eslint exit 0 on the changed files.
  - Open, not fixed in B3: a queued asset's estimate is held for its own run only. A later run does not count it until the poll stores the output. This is the same gap for the total and for every category, so it is a real hole in the allowance. Closing it needs the estimate on the asset job row, which is a migration and a separate change.
  - Full suite on the B3 commit (`ddc51db4`, run before one comment fix in `execute.ts`, which was re-tested after: 23 of 23): script tests 160 of 160; source tests 6122, of which 6081 pass, 0 fail, 41 skipped as environment-gated; exit 0.
- 2026-10-23. B4 model brief and priced candidates, done on fixtures and the public listings (read 2026-10-23, no key). Decision D10 in `DECISIONS_2026-10-23.md`.
  - `src/engine/prompts/model_brief@1.md`: four classes (text 12 rows, image 8, speech 8 (one sourced), video 4). Each row has the model id, its listing date (the listing's `created`), its price basis, and a quality note that is a source or "unverified". No Veo row.
  - Sources, as marked in the brief: Developers Digest (secondary) for the Artificial Analysis index of the two Claude 5.5 models; fal.ai (vendor-affiliated) for the image leaders, which the engine does not price; a Speechify release (vendor claim) for the speech board; DataLearner (secondary) for happyhorse-1.0. Every other quality note is unverified. The Artificial Analysis video board was not confirmed.
  - `validate.ts` `hasPriceBasis`: a candidate is a model the engine can price for its kind. `planner.ts` `candidatesFor` offers only those, so the planner stops choosing models a step would be refused for.
  - The role's user content carries the model brief before the untrusted blocks. `planInputTokensOf` adds the brief's size to the hold. `orchestrator_plan@3.md` (version unchanged) prefers the newest model that fits, names the brief, and says the candidates decide what exists.
  - Tests: `prompts/model_brief.test.ts` (loads; no Veo row; four cells per row with a date and a price basis; a sourced quality claim has a source in its section; sourced rows first, then newest first), the role test (brief before the blocks), the planner test (priced candidates only). Targeted suites pass (244 tests, including the four boundary suites). Typecheck exit 0; eslint exit 0 on the changed files.
  - Open for the owner: the engine reads only the per-second 1080p USD video price. Mapping other price forms would change what the engine prices, so it is not done here.
- 2026-10-23. B5 composer, approval and policy, done on fixtures. Decision D11 in `DECISIONS_2026-10-23.md`.
  - `src/engine/orchestrator/approval.ts`: `approvePlanBudget` raises a paused plan's set budget and its own budget together, conditionally on the plan still being paused. It is refused unless the plan is paused and the amount is above the budget it has now. `approval.test.ts` (PGlite, 3 tests): a paused run resumes after approval and completes; the refusals; another organization sees not found.
  - Server functions (`src/lib/meridian/orchestrator/actions.ts`): `getOrchestratorPolicyFor` (viewer), `saveOrchestratorPolicyFor` (admin: the tolerance and the switched-off families), `approveOrchestratorBudget` (admin). `createOrchestratorDraft` accepts a blank format when the person gives their own inputs, and still refuses a draft with neither a format nor inputs.
  - Composer (`orchestrator-composer.tsx`, `orchestrator-presentation.ts`): "A format to copy or make" or "My own inputs" decides which field is required. Three optional category budgets (copy, creative, voice); an empty one is unset, and the orchestrator splits it. `orchestrator-composer-rules.test.ts` (6 tests).
  - Plans (`orchestrator-plans.tsx`): a paused plan shows the reason of its last pause and an approval control (admin only). The approval raises the budget and asks the person to run the plan again.
  - Policy (`orchestrator-policy-panel.tsx`): the tolerance in percent and cents, a switch for Veo, and other families to switch off. The initial values come from the engine. A viewer reads the values; only an admin saves them.
  - Gates: the orchestrator and content-factory suites pass (226 tests, 0 fail). Typecheck exit 0. Eslint exit 0 on the changed files.
  - Not done: the brand-level policy the direction names (the policy is per workspace); an audit row for approvals; a browser check of the signed-in screens (see the next entry).
- 2026-10-23. Browser check of the signed-in screens, on the dev server (PGlite, a fixture account, workspace and brand, no provider key).
  - Found and fixed: the Content Factory page failed in the browser ("node:crypto has been externalized"). `categories.ts` (B3) imported the contracts index, which re-exports `hash.ts`. Fixed in `4be77e79` by importing `sumUsd` from `money.ts`. The targeted tests passed before the browser check found it.
  - Fixed: the policy panel's save message vanished, because the form remounts when the policy refetches. The message now lives in the panel.
  - Checked in the browser: the composer shows the "Start from" choice and the category budgets; "My own inputs" makes the format optional and the inputs required; the policy panel shows the initial values (10 percent, 25 cents, Veo off); a save shows "Saved", persists across a reload, and was put back to 10.
  - Screenshots in `docs/feature-screens/` (`orchestrator-composer` and `orchestrator-policy`, before and after, desktop and phone), with a section in the folder's README. The before side is the base `19223045`, run as a detached checkout that was removed afterwards.
  - Not checked: a plan's approval block (a paused plan needs the orchestrator's call, which needs a provider key); a live plan or run; the server path of the approval from the browser (its engine path is tested in `approval.test.ts`).
- 2026-10-23. B6 documents and B7 final gates.
  - B6: CLAUDE.md rule 3, the handoff's rule 7, Bible 14.1 (the reserve step and the cap mode), and the factory's autonomy table now say soft limits with a tolerance and an approval beyond the allowance. The phase log and the roadmap record the run. The 2026-10-20 plan is left as written. Commit `26947cf9`.
  - Final gates, on the tree of `26947cf9` (no file changed after the full run started):
    - `npm test`: script tests 160 of 160 pass. Source tests 6138, of which 6097 pass, 0 fail and 41 skipped as environment-gated. Exit 0.
    - `npm run typecheck`: exit 0.
    - `npm run lint`: 0 errors. Four warnings, in `market/intelligence-whitespace.tsx`, `page-commands.tsx` and `studio/direction-step.tsx`, none of them in a file this run changed.
    - `npm run build`: exit 0. The migrate step skips with no `DATABASE_URL`; the PGlite fallback migrates itself.
  - Not run, and why: a live run and a live planning call, since no provider key is set in this environment.
