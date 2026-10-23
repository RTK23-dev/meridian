# Status: budget approvals are recorded (D13) and the brand policy (D16)

Branch `feat/orchestrator-approvals-brand`, from `bbba4799`. Not pushed. The lead merges. `STATUS.md` in the orchestrator folder is not touched.

## What changed

Part A, D13 (migration 0118):
- `migrations/0118_orchestrator_budget_approvals.sql`: new table `orchestrator_budget_approvals` and its index on (organization, plan, created_at desc).
- `src/engine/orchestrator/approval.ts`: `approvePlanBudget` takes `actorId` and writes the plan update and the audit row in one statement. `listBudgetApprovals(sql, organizationId, planId, limit)` returns the plan's approvals newest first, scoped to the organization.
- `src/lib/meridian/orchestrator/actions.ts`: `approveOrchestratorBudget` passes `context.userId` as `actorId` (line 290). `listBudgetApprovalsFor` (viewer) is appended at line 362.

Part B, D16 (migration 0119):
- `migrations/0119_orchestrator_brand_policy.sql`: new table `orchestrator_brand_policies` (primary key organization and brand), and a nullable `brand_id` on `orchestrator_plans` with an index on (organization, brand).
- `src/engine/orchestrator/brand-policy.ts` (new): `effectiveDisabledFamilies(workspace, brand)` (union, unique, sorted, normalized, validated), `readBrandPolicy(sql, organizationId, brandId)`, `writeBrandPolicy(sql, {organizationId, brandId, actorId, disabledModelFamilies})` (upsert after validation). It does not import `policy-store.ts`; the family rule is copied in.
- `src/engine/orchestrator/store.ts`: `createPlanDraft` takes an optional `brandId`; `StoredPlan.brandId` is returned by `getPlan` and `listPlans`.
- `src/lib/meridian/orchestrator/actions.ts`: `getBrandPolicyFor` (viewer) and `saveBrandPolicyFor` (admin, `writeBrandPolicy` after `requireBrand(..., "admin")`), appended at lines 379 and 397.

## Decisions taken inside the brief

1. **One statement, not `sql.begin`.** D13 says the audit row is written "in the same statement as the plan's budget update". The brief said "one transaction (sql.begin ...)". I built D13 as written: a data-modifying CTE in one statement, which is atomic on its own. If the lead wants `sql.begin`, the change is local to `approvePlanBudget` (`withTransaction` in `learning/store.ts`).
2. The statement raises the plan with `jsonb_set` on `budgetUsd`, so a plan changed in between is never overwritten from a stale copy. Only that number changes, and the new JSON is not re-checked by zod.
3. The statement is conditional on the status being paused, the plan being present, and the budget still equal to the one read. A concurrent approval that meets a change is refused ("the plan changed while the approval was made"), and writes nothing.
4. The reason is read in the same statement from the plan's last `paused` event (`orchestrator_plan_events`), and cut to 500 characters, the column limit. An empty reason means no paused event was stored.
5. `listPlans` also selects `brand_id`, beyond the brief's list (`getPlan` and `createPlanDraft`). Without it, `listPlans` would return `brandId: null` for every plan.
6. `orchestrator_plans.brand_id` has a check (null, or 1 to 200 characters). The brief did not spell it out.

## Functions and their checks

- `approvePlanBudget`: not found; refused unless the plan is paused, has a checked plan, and the amount is finite and above the budget now. Then one statement.
- `listBudgetApprovals`: `organization_id` and `plan_id` in the query, `order by created_at desc, id desc`, limit 1 to 100.
- `readBrandPolicy`: empty when no row; throws when the stored list does not check.
- `writeBrandPolicy`: normalizes (lowercase, no leading ~), validates (vendor, or vendor/model prefix; at most 20), dedupes, sorts, then upserts.
- The brand server functions use `requireBrand` (`viewer` to read, `admin` to write), as the file's other functions do.

## Tests

- `src/engine/orchestrator/approval.test.ts`: 8 tests (3 existing, updated with `actorId`; 5 new). New: one audit row with actor, previous and approved budget and the pause reason; a refused approval writes no row; a failing audit insert (a trigger raises) leaves the plan exactly as it was; newest-first order, the limit, and organization scoping; two approvals at the same time.
- `src/engine/orchestrator/brand-policy.test.ts`: 11 tests (new). Union, a brand cannot remove a workspace family, one spelling per family, invalid and oversized lists refused, save and read, upsert, organization scoping, a malformed stored list refused on read, and a plan records its brand.
- `src/engine/orchestrator/store.test.ts`: 10 tests, unchanged, pass.
- All orchestrator tests (`src/engine/orchestrator/*.test.ts`): 247 run, 246 pass, 1 fail. The failure is `production.test.ts:159` ("a call past the request budget is not made"). It fails the same way on the base commit `bbba4799`, which I checked in an export of that commit. It is not caused by this branch.
- `scripts/migration-plan.test.mjs`: 8 pass. `src/engine/jobs/migration.test.ts`: 7 pass.
- `npm run typecheck`: pass. `npx eslint` on the six changed TypeScript files: pass.
- Mutation checks, in a scratch copy: a two-statement approval with no transaction fails the failing-insert test. Removing the budget compare-and-set fails the concurrency test. The worktree was not changed by these checks.
- Not verified: a live Postgres run. The test database here is PGlite, which runs one statement at a time. The concurrency test asserts the refusal only under PGlite. Under a real server it checks the invariants (each landed approval is recorded once, and the record chain matches the budget history) without fixing which approval wins.

## Not done: wiring and follow-ups

- **Brand families are not in any run or plan yet.** The exact call sites are in `src/engine/orchestrator/api.ts`. `catalogFor` (lines 52 to 66) is workspace-only: it filters the catalog with `policy.disabledModelFamilies` (line 58) and returns `disabledFamilies` (line 63). The brand must be read per plan in `planDraftFor` (line 68; `disabledFamilies` at line 78), `runPlanFor` (line 88; at line 98) and `editPlanStepFor` (line 138; at line 144). Each one needs `getPlan` for `brandId`, then `readBrandPolicy`, then `effectiveDisabledFamilies(workspace, brand)` in place of the workspace list, including the catalog filter at line 58.
- **Plans do not record a brand yet.** `createOrchestratorDraft` (`actions.ts`, the `createPlanDraft` call at line 157) does not pass `brandId`. One line, `brandId: data.brandId,`, is needed. The brief said to change nothing else in existing functions, so I did not.
- **No screen shows the approvals or the brand policy.** `orchestrator-plans.tsx` is off-limits to me. It should call `listBudgetApprovalsFor`. The brand policy has no screen.

## Bugs and doubts

1. `src/engine/orchestrator/policy-store.ts:43`: when a stored workspace row fails validation, `policyFrom` falls back to the initial policy as a whole. The initial disabled list may lack a family the workspace had switched off, so a malformed row can switch that family on. The comment at lines 37 to 38 says it never does. Not changed: the file is off-limits.
2. `src/engine/orchestrator/brand-policy.ts:74`: a stored brand list that does not check makes `readBrandPolicy` throw. Runs of that brand then stop until the row is fixed. That is fail-closed, but it can block a run.
3. `migrations/0119_orchestrator_brand_policy.sql` and `writeBrandPolicy`: `brand_id` has no foreign key, and nothing in the database checks that the brand belongs to the organization. The server functions check it with `requireBrand`. The engine function does not.
4. Migrations 0118 and 0119 are taken by this branch. Another branch that adds a migration with the same number will trip the migration-numbering test.
5. A family is a prefix (`src/engine/config/model-policy.ts:14` to `19`). A brand family such as one vendor name also switches off every id that begins with it. The owner should know a brand family is a prefix.
6. `approval.ts:48`: the pre-check compares JavaScript numbers with a `numeric` column. A budget with about 15 or more significant digits could fail the compare-and-set and be refused. Budgets are entered with two decimals, so this is theoretical.
7. `actions.ts`, `listBudgetApprovalsFor` (line 362): it returns user ids to every viewer of the brand's workspace. Names may be wanted.
8. The approval leaves the plan paused (D11), so approvals can stack before a run. Each one is recorded.
9. The audit reason is a copy of the `paused` event's text (`execute.ts:155` and `:170`). The other agent's change to the event wording will show up in new rows only.
