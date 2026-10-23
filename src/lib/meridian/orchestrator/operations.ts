// The checked operations behind the orchestrator's server functions (actions.ts). Each one checks the brand's organization and the caller's role
// first (brandAccessFor), and then does the work. The server functions call these with the database and the signed-in user, so the checks can
// be tested against a database without a request. This file uses relative imports only, so the test runner loads it as it is.

import { assertRole, hasRole, isRole, type Role } from "../access.ts";
import type { Sql } from "../learning/store.ts";
import { approvePlanBudget, listBudgetApprovals, type ApprovalOutcome, type BudgetApproval } from "../../../engine/orchestrator/approval.ts";
import type { BudgetCategory } from "../../../engine/orchestrator/categories.ts";
import { measuredAverageFor, runPlanFor, type ApiDeps, type CatalogState } from "../../../engine/orchestrator/api.ts";
import { effectiveDisabledFamilies, readBrandPolicy, writeBrandPolicy } from "../../../engine/orchestrator/brand-policy.ts";
import { INITIAL_POLICY, measureModeFor, requireOrchestratorPolicy, writeOrchestratorPolicy, type OrchestratorPolicy } from "../../../engine/orchestrator/policy-store.ts";
import type { RunOutcome } from "../../../engine/orchestrator/run.ts";
import { getPlan, type StoredPlan } from "../../../engine/orchestrator/store.ts";

/** The brand's organization and name, and the caller's role in that organization, checked against the minimum the action needs. */
export async function brandAccessFor(sql: Sql, userId: string, brandId: string, minimum: Role): Promise<{ organizationId: string; brandName: string; role: Role }> {
  const rows = await sql<{ organization_id: string; name: string }>`
    select organization_id, name from brands where id = ${brandId} and deleted_at is null limit 1
  `;
  const brand = rows[0];
  if (!brand) throw new Error("Brand not found.");
  const members = await sql<{ role: string }>`
    select role from memberships where user_id = ${userId} and organization_id = ${brand.organization_id} limit 1
  `;
  const role = members[0]?.role;
  if (!role || !isRole(role)) throw new Error("That workspace is not available to you.");
  assertRole(role, minimum);
  return { organizationId: brand.organization_id, brandName: brand.name, role };
}

/**
 * The workspace's switched-off families and measure ceiling, with the initial values. Any member of the brand's workspace reads it. A stored
 * row that cannot be read is refused with its reason (requireOrchestratorPolicy): no value is defaulted for a read.
 */
export async function readWorkspacePolicyAs(sql: Sql, userId: string, input: { brandId: string }): Promise<{ policy: OrchestratorPolicy; initial: OrchestratorPolicy }> {
  const access = await brandAccessFor(sql, userId, input.brandId, "viewer");
  return { policy: await requireOrchestratorPolicy(sql, access.organizationId), initial: INITIAL_POLICY };
}

/**
 * Saves the workspace's policy. Only a workspace admin changes it. An absent field keeps its value. A stored row that cannot be read is saved
 * again, and the save must state its model families.
 */
export async function saveWorkspacePolicyAs(
  sql: Sql,
  userId: string,
  input: { brandId: string; disabledModelFamilies?: string[]; measureCeilingUsdPerSecond?: number },
): Promise<{ policy: OrchestratorPolicy }> {
  const access = await brandAccessFor(sql, userId, input.brandId, "admin");
  const policy = await writeOrchestratorPolicy(sql, {
    organizationId: access.organizationId,
    actorId: userId,
    patch: { disabledModelFamilies: input.disabledModelFamilies, measureCeilingUsdPerSecond: input.measureCeilingUsdPerSecond },
  });
  return { policy };
}

/** The brand's own switched-off families, the workspace's, and the set a plan of this brand is held to (D16). */
export type BrandPolicyView = { brandFamilies: string[]; workspaceFamilies: string[]; effectiveFamilies: string[] };

/** The brand's policy as the screens show it. Any member of the brand's workspace reads it. */
export async function readBrandPolicyAs(sql: Sql, userId: string, input: { brandId: string }): Promise<BrandPolicyView> {
  const access = await brandAccessFor(sql, userId, input.brandId, "viewer");
  const workspace = await requireOrchestratorPolicy(sql, access.organizationId);
  const brandFamilies = await readBrandPolicy(sql, access.organizationId, input.brandId);
  return { brandFamilies, workspaceFamilies: workspace.disabledModelFamilies, effectiveFamilies: effectiveDisabledFamilies(workspace.disabledModelFamilies, brandFamilies) };
}

/**
 * Saves the brand's switched-off families. Only a workspace admin changes it. A brand may only add families (D16): the workspace's stay off.
 * The answer names the workspace's families, so an unreadable workspace policy refuses the save before anything is written.
 */
export async function saveBrandPolicyAs(sql: Sql, userId: string, input: { brandId: string; disabledModelFamilies: string[] }): Promise<BrandPolicyView> {
  const access = await brandAccessFor(sql, userId, input.brandId, "admin");
  const workspace = await requireOrchestratorPolicy(sql, access.organizationId);
  const brandFamilies = await writeBrandPolicy(sql, {
    organizationId: access.organizationId,
    brandId: input.brandId,
    actorId: userId,
    disabledModelFamilies: input.disabledModelFamilies,
  });
  return { brandFamilies, workspaceFamilies: workspace.disabledModelFamilies, effectiveFamilies: effectiveDisabledFamilies(workspace.disabledModelFamilies, brandFamilies) };
}

/**
 * Approves a paused plan's line. Only a workspace admin approves; the approval is recorded with the signed-in user (D13). A category pause is
 * approved with its category (D3, D12): that category's line is raised and the total is not. The category is forwarded as it is given.
 */
export async function approveBudgetAs(
  sql: Sql,
  userId: string,
  input: { brandId: string; planId: string; budgetUsd: number; category?: BudgetCategory | null },
): Promise<{ outcome: ApprovalOutcome; stored: StoredPlan | null }> {
  const access = await brandAccessFor(sql, userId, input.brandId, "admin");
  const category = input.category ?? undefined;
  const outcome = await approvePlanBudget(sql, { organizationId: access.organizationId, planId: input.planId, budgetUsd: input.budgetUsd, actorId: userId, category });
  return { outcome, stored: outcome.status === "approved" ? await getPlan(sql, access.organizationId, input.planId) : null };
}

/** A plan's budget approvals, newest first. Any member of the brand's workspace reads them. */
export async function listApprovalsAs(sql: Sql, userId: string, input: { brandId: string; planId: string }): Promise<{ approvals: BudgetApproval[] }> {
  const access = await brandAccessFor(sql, userId, input.brandId, "viewer");
  if ((await getPlan(sql, access.organizationId, input.planId)) === null) throw new Error("Plan not found.");
  return { approvals: await listBudgetApprovals(sql, access.organizationId, input.planId, 50) };
}

/**
 * Runs a plan. Only a workspace admin runs one, and measure mode (D15) is an admin's choice: a run that asks for it without the admin role is
 * refused, and an admin's run is held to the workspace's ceiling. A run whose workspace policy is unreadable is refused with its reason.
 */
export async function runPlanAs(
  sql: Sql,
  userId: string,
  input: { brandId: string; planId: string; measure: boolean },
  deps: ApiDeps = {},
): Promise<{ outcome: RunOutcome | CatalogState; stored: StoredPlan | null }> {
  const access = await brandAccessFor(sql, userId, input.brandId, "admin");
  const mode = measureModeFor(await requireOrchestratorPolicy(sql, access.organizationId), { measure: input.measure, admin: hasRole(access.role, "admin") });
  if (mode.status === "refused") throw new Error(mode.reason);
  const now = () => new Date().toISOString();
  const outcome = await runPlanFor(sql, { organizationId: access.organizationId, planId: input.planId, now, measure: mode.measure }, deps);
  return { outcome, stored: await getPlan(sql, access.organizationId, input.planId) };
}

/** The measured average cost per second of the workspace's clips (D15). Any member of the brand's workspace reads it. */
export async function measuredAverageAs(sql: Sql, userId: string, input: { brandId: string }): Promise<{ measuredAverageUsdPerSecond: number | null; clips: number; seconds: number }> {
  const access = await brandAccessFor(sql, userId, input.brandId, "viewer");
  return measuredAverageFor(sql, access.organizationId);
}
