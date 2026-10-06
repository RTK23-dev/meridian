import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { assertRole, isRole } from "@/lib/meridian/access";
import { liveTransport } from "../providers/http.ts";

export const refreshStoredToken = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const body = input && typeof input === "object" ? (input as { organizationId?: unknown; provider?: unknown }) : {};
    const organizationId = typeof body.organizationId === "string" ? body.organizationId : "";
    const provider = body.provider === "meta" || body.provider === "tiktok" || body.provider === "google" ? body.provider : "";
    if (!organizationId || !provider) throw new Error("Choose a workspace and a provider.");
    return { organizationId, provider };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const { openSecret, refreshOauthToken, sealSecret } = await import("./flow.server.ts");
    const sql = await getSql();
    const members = await sql<{ role: string }>`
      select role from memberships where user_id = ${context.userId} and organization_id = ${data.organizationId} limit 1
    `;
    const role = members[0]?.role;
    if (!role || !isRole(role)) throw new Error("That workspace is not available to you.");
    assertRole(role, "admin");
    const rows = await sql<{ sealed_refresh: string }>`
      select sealed_refresh from provider_secrets
      where organization_id = ${data.organizationId} and provider = ${data.provider}
      limit 1
    `;
    const sealed = rows[0]?.sealed_refresh ?? "";
    if (!sealed) return { status: "missing" as const, detail: "No refresh token is stored. Connect again. Nothing was rotated." };
    const opened = openSecret(sealed, process.env.TOKEN_ENCRYPTION_KEY ?? "");
    if (typeof opened !== "string") return { status: "missing" as const, detail: opened.error };
    const provider = data.provider === "meta" || data.provider === "tiktok" || data.provider === "google" ? data.provider : null;
    if (!provider) throw new Error("Unknown provider.");
    const refreshed = await refreshOauthToken(provider, { refreshToken: opened, env: process.env }, liveTransport());
    if ("error" in refreshed) return { status: "failed" as const, detail: refreshed.error };
    const next = sealSecret(refreshed.accessToken, process.env.TOKEN_ENCRYPTION_KEY ?? "");
    const nextRefresh = sealSecret(refreshed.refreshToken, process.env.TOKEN_ENCRYPTION_KEY ?? "");
    if (typeof next !== "string" || typeof nextRefresh !== "string") {
      return { status: "failed" as const, detail: "TOKEN_ENCRYPTION_KEY is not configured. The token was not replaced." };
    }
    await sql`
      update provider_secrets set sealed_token = ${next}, sealed_refresh = ${nextRefresh}, updated_at = now()
      where organization_id = ${data.organizationId} and provider = ${data.provider}
    `;
    return { status: "rotated" as const, detail: "The provider returned a new access token. It is stored sealed and is not shown here." };
  });