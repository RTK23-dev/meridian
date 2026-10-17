import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { assertRole, isRole } from "@/lib/meridian/access";

import { oauthReturnPath } from "./return-path.ts";

export const beginOauth = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as { organizationId?: unknown; provider?: unknown; origin?: unknown; returnTo?: unknown }) : {};
    const organizationId = typeof body.organizationId === "string" ? body.organizationId : "";
    const provider = body.provider === "meta" || body.provider === "tiktok" || body.provider === "google" ? body.provider : "";
    const origin = typeof body.origin === "string" ? body.origin : "";
    const returnTo = oauthReturnPath(typeof body.returnTo === "string" ? body.returnTo : "");
    if (!organizationId || !provider || !origin) throw new Error("OAuth needs a workspace, a provider, and this site's origin.");
    return { organizationId, provider, origin, returnTo };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const { authorizationUrl, hashOauthState, newOauthState, isAllowedOauthOrigin } = await import("./flow.server.ts");
    const sql = await getSql();
    const members = await sql<{ role: string }>`
      select role from memberships where user_id = ${context.userId} and organization_id = ${data.organizationId} limit 1
    `;
    const role = members[0]?.role;
    if (!role || !isRole(role)) throw new Error("That workspace is not available to you.");
    assertRole(role, "admin");
    if (!isAllowedOauthOrigin(data.origin, process.env)) throw new Error("This site origin is not allowed to start OAuth. Configure MERIDIAN_ALLOWED_OAUTH_ORIGINS.");
    const state = newOauthState();
    const redirectUri = `${data.origin}/api/oauth/callback?provider=${data.provider}`;
    const provider = data.provider === "meta" || data.provider === "tiktok" || data.provider === "google" ? data.provider : null;
    if (!provider) throw new Error("Unknown provider.");
    const built = authorizationUrl(provider, { state, redirectUri, env: process.env });
    if ("error" in built) throw new Error(built.error);
    await sql`
      insert into oauth_states (state_hash, organization_id, provider, expires_at, redirect_origin, user_id, return_path)
      values (${hashOauthState(state)}, ${data.organizationId}, ${data.provider}, now() + interval '10 minutes', ${data.origin}, ${context.userId}, ${data.returnTo})
    `;
    return { url: built.url };
  });