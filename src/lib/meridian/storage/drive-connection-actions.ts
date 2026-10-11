import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { assertRole, isRole, type Role } from "@/lib/meridian/access";
import type { DriveConnectionView } from "./drive-connection-view.ts";

function organizationIdOf(input: unknown): string {
  const value = input && typeof input === "object" ? (input as { organizationId?: unknown }).organizationId : undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error("A workspace is required.");
  return value;
}

/** The caller's role in the workspace. A caller with no membership in it is refused. */
async function memberRole(userId: string, organizationId: string): Promise<Role> {
  const sql = await getSql();
  const rows = await sql<{ role: string }>`
    select role from memberships where user_id = ${userId} and organization_id = ${organizationId} limit 1
  `;
  const role = rows[0]?.role;
  if (!role || !isRole(role)) throw new Error("That workspace is not available to you.");
  return role;
}

/** The Drive connection as the deployment is set up. Names and presence only, never a key or a token. */
export const getDriveConnection = createServerFn({ method: "GET" })
  .validator((input: unknown) => ({ organizationId: organizationIdOf(input) }))
  .middleware([authMiddleware])
  .handler(async ({ context, data }): Promise<DriveConnectionView> => {
    await memberRole(context.userId, data.organizationId);
    const { driveConnectionView } = await import("./drive-connection-view.ts");
    return driveConnectionView(process.env);
  });

/**
 * Asks Drive whether the configured credentials work: one read of the Drive API. It is not a write, but it spends a
 * Google request on the deployment's credentials, so it is limited to admins.
 */
export const checkDriveConnection = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ organizationId: organizationIdOf(input) }))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    assertRole(await memberRole(context.userId, data.organizationId), "admin");
    const { googleDriveClient } = await import("./drive.ts");
    const health = await googleDriveClient.health();
    return { status: health.status, detail: health.detail, checkedAt: new Date().toISOString() };
  });
