# Status: approvals (D13), the brand policy (D16), and measure mode (D15)

Branch `feat/orchestrator-approvals-brand`. Not pushed. The lead merges.

## Merge

- The run branch at `45ce8ff1` already contained this branch's commit `3e2b4f59` (merged as `66d2ade0`). Merging it here was a fast-forward, with no conflicts.
- Baseline on the merged tree: 263 orchestrator tests, 262 passing. The one failure, `production.test.ts:159` ("a call past the request budget is not made"), predates this branch: D12 made a budget a line, and the test still expects a refusal at the request budget.

## Brand override (D16): the families a plan is held to

- `api.ts` `disabledFamiliesFor(sql, organizationId, planId)`: the workspace's families, plus the brand's when the plan records a brand (`brand-policy.ts` `effectiveDisabledFamilies`). A plan with no brand, or one that is not the organization's, uses the workspace's alone.
- `api.ts` wiring: `catalogFor` (line 90) filters the catalog with the plan's set. `planDraftFor` (line 99), `runPlanFor` (line 128) and `editPlanStepFor` (line 188) each resolve the set with `disabledFamiliesFor` first.
- `actions.ts` `createOrchestratorDraft` (line 120): an optional `planBrandId`. The composer's `brandId` stays the acting brand and stays required, because `requireBrand` needs it. The plan's brand is looked up with `requireBrand` (viewer) and refused unless it belongs to the caller's workspace (`planBrandRefusal`, `brand-policy.ts`). When `planBrandId` is absent, the acting brand is recorded (line 172), so the brand's families apply to plans made under it. The brief said "absent, no brand". Recording the acting brand fails closed instead. The owner should confirm it.

## Measure mode (D15)

- `policy-store.ts`: `measureCeilingUsdPerSecond` is in the same strict schema and the same row as the families. Initial value 0.50; range 0.01 to 5, checked by zod, so an out-of-range value writes nothing. `saveOrchestratorPolicyFor` takes it, for an admin.
- `policy-store.ts` `measureModeFor(policy, { measure, admin })`: off when not asked; refused for a non-admin who asks; otherwise the workspace's ceiling as `MeasureOptions`.
- `actions.ts` `runOrchestratorPlan` (line 199) takes `measure: boolean` (a value that is not a boolean is refused). It checks the role with `hasRole` through `measureModeFor`, and passes the options to `runPlanFor`. The run itself already requires an admin.

## Averages (D15)

- `api.ts` `measuredAverageFor(sql, organizationId)` (line 203) returns `{ measuredAverageUsdPerSecond, clips, seconds }` from `holds.ts`. `actions.ts` `getMeasuredAverageFor` (line 444) is the viewer function.

## Planning gap

- `validate.ts`: a `planning` option. When planning, a video or avatar step with no per-second price and no measure mode is a note, not a refusal, and it has no cost. The run (`validatePlan` without `planning`) still refuses it without measure mode, with a reason that says so. Every other unpriced step is still refused.
- `planner.ts` (`planWithRole`, `planWithModel`) and `service.ts` (`callAndStore`) plan with that option. `service.ts` `checkPlanCall` says "switched off by the model policy" for a disabled orchestrator, instead of "not in the live catalog".

## Server functions for the UI

- `runOrchestratorPlan({ brandId, planId, measure })`: the run, with measure mode for an admin.
- `getMeasuredAverageFor({ brandId })`: the measured average.
- `getBrandPolicyFor({ brandId })` and `saveBrandPolicyFor({ brandId, disabledModelFamilies })`: the brand policy.
- `listBudgetApprovalsFor({ brandId, planId })`: a plan's approvals, newest first.
- `saveOrchestratorPolicyFor({ brandId, disabledModelFamilies?, measureCeilingUsdPerSecond? })`: the workspace's ceiling and families.
- `createOrchestratorDraft({ ..., planBrandId? })`: a draft for a brand.

## Tests

- `api.test.ts` (new, 10): the families at each entry point. A brand's family reaches the editor, the planner's catalog and the runner, and no other organization's brand or workspace family does. The averages: null with none, the ratio with clips, organization-scoped.
- `measure-plan.test.ts` (new, 3): a draft with an unpriced video step is stored with a note. The run refuses it without measure mode, and completes it with measure mode at the ceiling. Another unpriced step is still refused at planning.
- `validate-planning.test.ts` (new, 3): the planning note, the run refusal, the other refusals, and the measured hold.
- `policy-store.test.ts`: the ceiling's start value, its range, the strict parse, the single row, and the measure decision. A malformed row is unreadable, with its reason, and switches no family on. A missing key takes its initial value. A save over an unreadable row must state the families.
- `operations.test.ts` (new, 9): the role and tenancy of each orchestrator operation in `actions.ts`, against a migrated database, including an unreadable policy row.
- `brand-policy.test.ts`: `planBrandRefusal`.
- Orchestrator suite (`src/engine/orchestrator/*.test.ts`): 301 run, 301 pass. Budget 159/159, render 77/77, assets 149/149, jobs 314/314, `operations.test.ts` 9/9. `npm run typecheck`: pass. `eslint` on the changed files: pass.
- `npm run typecheck`: pass. `npx eslint` on the changed files: pass.
- Not tested: the server functions in `actions.ts`. The file imports `@/` aliases, which the test runner cannot resolve. The rules they call are tested in the engine.

## Open

1. Factory shot and voice jobs (`jobs/runtime.ts`, `shotGeneratorOf` and the voice router) route without the workspace's families, so a route-table fallback there can reach a switched-off family. A plan run's router is filtered (`router.ts`, `api.ts`). A settle-time fallback reuses the targets carried from submit, and the poll router has no families, so a family switched off while a job is in flight is not excluded. Fixing both needs the families on the factory and poll routers. Not verified in a live run.
2. Resolved: an unpriced video or avatar edit is stored with a note, and refused at run time without measure mode (`run.ts`, `measure-edit.test.ts`).
3. `api.ts` `textModelsFor` (line 82) gives the composer the workspace's families, not the brand's. The planner still refuses a model the brand switched off.
4. Resolved: a malformed policy row is unreadable. Planning, runs, edits and the model list refuse with "the workspace's orchestrator policy is unreadable; save the policy again", and no family is reset or switched on. The read reports the row as unreadable. The policy panel (`orchestrator-policy-panel.tsx`) would show that reason as an error, but it has no form to save the policy again. That needs a UI change, which is outside this change.
5. `brand_id` has no foreign key and no organization check in the database (`migrations/0119`). The server functions check it with `requireBrand`.
6. Migrations 0118 and 0119 are on this branch. Another branch with the same numbers will trip the numbering test.
