import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { exchangeOauthCode, hashOauthState, isAllowedOauthOrigin, sealSecret } from "@/lib/meridian/oauth/flow.server";
import { liveTransport } from "@/lib/meridian/providers/http";

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
        const sql = await getSql();
        const stateHash = hashOauthState(state);
        const claimed = await sql<{ organization_id: string }>`
          update oauth_states set used_at = now()
          where state_hash = ${stateHash} and provider = ${provider} and used_at is null and expires_at > now()
          returning organization_id
        `;
        const match = claimed[0];
        if (!match) return new Response("The OAuth state is missing, used, or expired.", { status: 400 });
        const exchanged = await exchangeOauthCode(provider, { code, redirectUri: `${url.origin}/api/oauth/callback?provider=${provider}`, env: process.env }, liveTransport());
        if ("error" in exchanged) return new Response(exchanged.error, { status: 502 });
        const sealed = sealSecret(exchanged.accessToken, process.env.TOKEN_ENCRYPTION_KEY ?? "");
        if (typeof sealed !== "string") return new Response(sealed.error, { status: 500 });
        const sealedRefresh = exchanged.refreshToken ? sealSecret(exchanged.refreshToken, process.env.TOKEN_ENCRYPTION_KEY ?? "") : "";
        if (typeof sealedRefresh !== "string") return new Response(sealedRefresh.error, { status: 500 });
        await sql`
          insert into provider_secrets (id, organization_id, provider, sealed_token, sealed_refresh)
          values (${crypto.randomUUID()}, ${match.organization_id}, ${provider}, ${sealed}, ${sealedRefresh})
          on conflict (organization_id, provider) do update set
            sealed_token = excluded.sealed_token,
            sealed_refresh = excluded.sealed_refresh,
            updated_at = now()
        `;
        return new Response(null, { status: 302, headers: { location: "/integrations" } });
      },
    },
  },
});
