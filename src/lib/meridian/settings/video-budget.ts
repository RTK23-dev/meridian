/**
 * A workspace's "Monthly video budget (USD)". One value per workspace, stored on organizations.monthly_video_budget_usd
 * (migration 0078). It is nullable and has no default: null means no budget is set, and the engine reads null as "no
 * budget", never as zero and never as unlimited. A set budget has at most two decimals and is never negative.
 *
 * `monthlyVideoBudgetUsd` is the read the video engine uses (wired to its WorkspaceBudgetSource by the lead). The settings
 * screen reads and saves through `readWorkspaceVideoBudget` and `saveWorkspaceVideoBudget`, which check the caller's
 * membership in the workspace first: any member may read it, and only an admin may change it.
 */
import { randomUUID } from "node:crypto";
import { assertRole, isRole, type Role } from "../access.ts";
import type { Sql } from "../learning/store.ts";
import { parseMonthlyVideoBudget } from "./video-budget-model.ts";

export { MAX_MONTHLY_VIDEO_BUDGET_USD, VIDEO_BUDGET_MESSAGE, parseMonthlyVideoBudget, type VideoBudgetParse } from "./video-budget-model.ts";

/** A stored value as a number, or null. A value that cannot be read is null, so it never becomes a budget by accident. */
function storedBudget(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const value = typeof raw === "number" ? raw : Number(String(raw));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The monthly video budget of one workspace in US dollars, or null when none is set, the workspace does not exist, or no
 * workspace is in scope. The read is scoped to that one organization. It throws only when the database cannot be read.
 */
export async function monthlyVideoBudgetUsd(sql: Sql, organizationId: string): Promise<number | null> {
  const scope = organizationId?.trim() ?? "";
  if (!scope) return null;
  const rows = await sql<{ budget: string | null }>`
    select monthly_video_budget_usd::text as budget from organizations where id = ${scope} limit 1
  `;
  return storedBudget(rows[0]?.budget);
}

/** The caller's role in the workspace. A non-member is refused with the same words every workspace check uses. */
async function requireRole(sql: Sql, userId: string, organizationId: string, minimum: Role): Promise<void> {
  const rows = await sql<{ role: string }>`
    select role from memberships where user_id = ${userId} and organization_id = ${organizationId} limit 1
  `;
  const role = rows[0]?.role;
  if (!role || !isRole(role)) throw new Error("That workspace is not available to you.");
  assertRole(role, minimum);
}

/** The budget as the settings screen shows it. Any member of the workspace may read it. */
export async function readWorkspaceVideoBudget(
  sql: Sql,
  input: { userId: string; organizationId: string },
): Promise<{ monthlyVideoBudgetUsd: number | null }> {
  await requireRole(sql, input.userId, input.organizationId, "viewer");
  return { monthlyVideoBudgetUsd: await monthlyVideoBudgetUsd(sql, input.organizationId) };
}

/**
 * Saves (or clears, with blank) the workspace's monthly video budget. Only an admin of that workspace may change it. The
 * update and its audit record are written for that one organization only.
 */
export async function saveWorkspaceVideoBudget(
  sql: Sql,
  input: { userId: string; organizationId: string; value: unknown },
): Promise<{ monthlyVideoBudgetUsd: number | null }> {
  await requireRole(sql, input.userId, input.organizationId, "admin");
  const parsed = parseMonthlyVideoBudget(input.value);
  if (!parsed.ok) throw new Error(parsed.message);
  const stored = parsed.value === null ? null : parsed.value.toFixed(2);
  const updated = await sql<{ id: string }>`
    update organizations set monthly_video_budget_usd = ${stored}, updated_at = now()
    where id = ${input.organizationId}
    returning id
  `;
  if (!updated[0]) throw new Error("That workspace is not available to you.");
  await sql`
    insert into audit_log (id, organization_id, actor_id, action, object_type, object_id, metadata)
    values (
      ${randomUUID()}, ${input.organizationId}, ${input.userId}, 'video_budget.updated', 'organization', ${input.organizationId},
      ${JSON.stringify({ monthlyVideoBudgetUsd: stored })}
    )
  `;
  return { monthlyVideoBudgetUsd: parsed.value };
}
