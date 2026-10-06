import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { assertRole, isRole } from "@/lib/meridian/access";

export const beginOauth = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as { organizationId?: unknown; provider?: unknown; origin?: unknown }) : {};
    const organizationId = typeof body.organizationId === "string" ? body.organizationId : "";
    const provider = body.provider === "meta" || body.provider === "tiktok" || body.provider === "google" ? body.provider : "";
    const origin = typeof body.origin === "string" ? body.origin : "";
    if (!organizationId || !provider || !origin) throw new Error("OAuth needs a workspace, a provider, and this site's origin.");
    return { organizationId, provider, origin };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const { authorizationUrl, hashOauthState, newOauthState } = await import("./flow.server.ts");
    const sql = await getSql();
    const members = await sql<{ role: string }>`
      select role from memberships where user_id = ${context.userId} and organization_id = ${data.organizationId} limit 1
    `;
    const role = members[0]?.role;
    if (!role || !isRole(role)) throw new Error("That workspace is not available to you.");
    assertRole(role, "admin");
    const state = newOauthState();
    const redirectUri = `${data.origin}/api/oauth/callback?provider=${data.provider}`;
    const provider = data.provider === "meta" || data.provider === "tiktok" || data.provider === "google" ? data.provider : null;
    if (!provider) throw new Error("Unknown provider.");
    const built = authorizationUrl(provider, { state, redirectUri, env: process.env });
    if ("error" in built) throw new Error(built.error);
    await sql`
      insert into oauth_states (state_hash, organization_id, provider, expires_at)
      values (${hashOauthState(state)}, ${data.organizationId}, ${data.provider}, now() + interval '10 minutes')
    `;
    return { url: built.url };
  });