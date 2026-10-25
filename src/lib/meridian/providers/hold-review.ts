// An administrator's review of uncertain budget holds: the list, and the one action that releases a hold. Only an admin of the workspace
// may do either. The role check runs here, in the library, so a test can prove that a member or an outsider is refused. The server
// function only passes the signed-in user through. The release itself, and its audit row, are in generation-ledger.ts.

import { assertRole, isRole } from "../access.ts";
import type { Sql } from "../learning/store.ts";
import { releaseUncertainHold, uncertainHolds, type HoldRelease, type UncertainHold } from "./generation-ledger.ts";

async function requireAdmin(sql: Sql, userId: string, organizationId: string): Promise<void> {
  const rows = await sql<{ role: string }>`
    select role from memberships where user_id = ${userId} and organization_id = ${organizationId} limit 1
  `;
  const role = rows[0]?.role;
  if (!role || !isRole(role)) throw new Error("That workspace is not available to you.");
  assertRole(role, "admin");
}

/** The uncertain holds of one workspace, for an administrator to check against the provider's account. */
export async function listUncertainHoldsAs(sql: Sql, input: { userId: string; organizationId: string }): Promise<UncertainHold[]> {
  await requireAdmin(sql, input.userId, input.organizationId);
  return uncertainHolds(sql, input.organizationId);
}

/** Releases one uncertain hold, on an administrator's reason. The release is audited with the administrator's id. */
export async function releaseHoldAs(
  sql: Sql,
  input: { userId: string; organizationId: string; holdId: string; reason: string },
): Promise<HoldRelease> {
  await requireAdmin(sql, input.userId, input.organizationId);
  return releaseUncertainHold(sql, {
    organizationId: input.organizationId,
    holdId: input.holdId,
    actorId: input.userId,
    reason: input.reason,
  });
}
