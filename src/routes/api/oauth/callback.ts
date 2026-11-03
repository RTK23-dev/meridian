import { tokenEncryptionKey } from "../../../lib/meridian/credentials/secret-settings.ts";
import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { exchangeOauthCode, hashOauthState, isAllowedOauthOrigin, sealSecret } from "@/lib/meridian/oauth/flow.server";
import { claimOauthState } from "@/lib/meridian/oauth/state";
import { liveTransport } from "@/lib/meridian/providers/http";
import { signedInUserId } from "@/lib/meridian/storage/drive-route-auth.server";
import { oauthReturnPath } from "@/lib/meridian/oauth/return-path";
import { isWorkspaceAdmin } from "@/lib/meridian/oauth/admin-check";

export const Route = createFileRoute("/api/oauth/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        if (!isAllowedOauthOrigin(url.origin, process.env)) return new Response("OAuth callback origin is not allowed.", { status: 400 });
        const provider = url.searchParams.get("provider") ?? "";
        const state = url.searchParams.get("state") ?? "";
        const code = url.searchParams.get("code") ?? "";
        if (provider !== "meta" && provider !== "tiktok" && provider !== "google") {
          return new Response("Unknown provider.", { status: 400 });
        }
        // The connection is bound to the person who started it. Any other signed-in person, or nobody, is refused.
        const userId = await signedInUserId(request);
        if (!userId) return new Response("Sign in as the person who started the connection.", { status: 401 });
        const sql = await getSql();
        // The state is consumed before the exchange, so a failed exchange cannot be retried with the same state.
        const match = await claimOauthState(sql, { stateHash: hashOauthState(state), userId, provider, origin: url.origin });
        if (!match) {
          return new Response("The OAuth state is missing, used, expired, came from another origin, or belongs to another person.", { status: 400 });
        }
        // The person who started the connection must still be an admin of the workspace: a person demoted or removed since then cannot finish it.
        if (!(await isWorkspaceAdmin(sql, userId, match.organizationId))) {
          return new Response("Only an admin of the workspace can finish this connection. Start it again as an admin.", { status: 403 });
        }
        // The exchange must send the redirect URI the authorization was started with, so it comes from the stored state.
        const redirectUri = `${match.redirectOrigin}/api/oauth/callback?provider=${provider}`;
        const exchanged = await exchangeOauthCode(provider, { code, redirectUri, env: process.env }, liveTransport());
        if ("error" in exchanged) return new Response(exchanged.error, { status: 502 });
        const sealed = sealSecret(exchanged.accessToken, tokenEncryptionKey() ?? "");
        if (typeof sealed !== "string") return new Response(sealed.error, { status: 500 });
        const sealedRefresh = exchanged.refreshToken ? sealSecret(exchanged.refreshToken, tokenEncryptionKey() ?? "") : "";
        if (typeof sealedRefresh !== "string") return new Response(sealedRefresh.error, { status: 500 });
        // The token's expiry is kept when the provider states one, so a token that has passed it is not reported as usable (review 2026-10-22, item 6).
        const expiresAt = exchanged.expiresIn === null ? null : new Date(Date.now() + exchanged.expiresIn * 1000).toISOString();
        await sql`
          insert into provider_secrets (id, organization_id, provider, sealed_token, sealed_refresh, expires_at)
          values (${crypto.randomUUID()}, ${match.organizationId}, ${provider}, ${sealed}, ${sealedRefresh}, ${expiresAt})
          on conflict (organization_id, provider) do update set
            sealed_token = excluded.sealed_token,
            sealed_refresh = excluded.sealed_refresh,
            expires_at = excluded.expires_at,
            updated_at = now()
        `;
        return new Response(null, { status: 302, headers: { location: oauthReturnPath(match.returnPath) } });
      },
    },
  },
});
