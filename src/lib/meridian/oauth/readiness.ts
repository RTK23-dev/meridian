import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { isRole } from "@/lib/meridian/access";
import { oauthClientReadiness } from "./client-readiness.ts";

export { oauthClientReadiness, type AccountOauthProvider, type OauthClientReadiness } from "./client-readiness.ts";

/** Any member of the workspace can see whether sign-in is set up. Starting sign-in still needs an admin (see begin.ts). */
export const oauthClientReadinessAction = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as { organizationId?: unknown }) : {};
    const organizationId = typeof body.organizationId === "string" ? body.organizationId : "";
    if (!organizationId) throw new Error("Choose a workspace.");
    return { organizationId };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const members = await sql<{ role: string }>`
      select role from memberships where user_id = ${context.userId} and organization_id = ${data.organizationId} limit 1
    `;
    const role = members[0]?.role;
    if (!role || !isRole(role)) throw new Error("That workspace is not available to you.");
    return oauthClientReadiness(process.env);
  });
