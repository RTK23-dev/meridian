/**
 * The brand membership check that brand-scoped server functions run first: the brand must exist and not be deleted, the
 * caller must be a member of its workspace, and that member's role must reach the minimum. It is kept free of path
 * aliases, so the node test runner can load the access-checked entry points as well as the server functions.
 */
import type { Sql } from "./learning/store.ts";
import { assertRole, isRole, type Role } from "./access.ts";

export async function requireBrand(
  sql: Sql,
  userId: string,
  brandId: string,
  minimum: Role,
): Promise<{ organizationId: string; role: Role }> {
  const rows = await sql<{ organization_id: string }>`
    select organization_id from brands where id = ${brandId} and deleted_at is null limit 1
  `;
  const organizationId = rows[0]?.organization_id;
  if (!organizationId) throw new Error("Brand not found.");
  const members = await sql<{ role: string }>`
    select role from memberships where user_id = ${userId} and organization_id = ${organizationId} limit 1
  `;
  const role = members[0]?.role;
  if (!role || !isRole(role)) throw new Error("That workspace is not available to you.");
  assertRole(role, minimum);
  return { organizationId, role };
}
