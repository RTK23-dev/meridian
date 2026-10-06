import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { exchangeOauthCode, hashOauthState, oauthStateMatches, sealSecret } from "@/lib/meridian/oauth/flow";
import { liveTransport } from "@/lib/meridian/providers/http";

export const Route = createFileRoute("/api/oauth/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const provider = url.searchParams.get("provider") ?? "";
        const state = url.searchParams.get("state") ?? "";
        const code = url.searchParams.get("code") ?? "";
        if (provider !== "meta" && provider !== "tiktok" && provider !== "google") {
          return new Response("Unknown provider.", { status: 400 });
        }
        const sql = await getSql();
        const rows = await sql<{ state_hash: string; organization_id: string; expires_at: string; used_at: string | null }>`
          select state_hash, organization_id, expires_at, used_at from oauth_states where provider = ${provider}
        `;
        const match = rows.find((row) => oauthStateMatches(row.state_hash, state) && !row.used_at && Date.parse(row.expires_at) > Date.now());
        if (!match) return new Response("The OAuth state is missing, used, or expired.", { status: 400 });
        const exchanged = await exchangeOauthCode(provider, { code, redirectUri: `${url.origin}/api/oauth/callback?provider=${provider}`, env: process.env }, liveTransport());
        if ("error" in exchanged) return new Response(exchanged.error, { status: 502 });
        const sealed = sealSecret(exchanged.accessToken, process.env.TOKEN_ENCRYPTION_KEY ?? "");
        if (typeof sealed !== "string") return new Response(sealed.error, { status: 500 });
        await sql`
          insert into provider_secrets (id, organization_id, provider, sealed_token)
          values (${crypto.randomUUID()}, ${match.organization_id}, ${provider}, ${sealed})
          on conflict (organization_id, provider) do update set sealed_token = excluded.sealed_token, updated_at = now()
        `;
        await sql`update oauth_states set used_at = now() where state_hash = ${hashOauthState(state)}`;
        return new Response(null, { status: 302, headers: { location: "/integrations" } });
      },
    },
  },
});
