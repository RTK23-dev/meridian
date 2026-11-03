// Whether a person is still an admin (or owner) of a workspace. The OAuth callback asks this before it stores a token: the person who
// started a connection may have been demoted or removed in the minutes before the provider sent them back.
import { hasRole, isRole } from "../access.ts";
import type { Sql } from "../learning/store.ts";

export async function isWorkspaceAdmin(sql: Sql, userId: string, organizationId: string): Promise<boolean> {
  const rows = await sql<{ role: string }>`
    select role from memberships where user_id = ${userId} and organization_id = ${organizationId} limit 1
  `;
  const role = rows[0]?.role;
  return Boolean(role) && isRole(role as string) && hasRole(role as "viewer", "admin");
}
