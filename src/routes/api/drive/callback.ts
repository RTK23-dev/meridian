import { tokenEncryptionKey } from "../../../lib/meridian/credentials/secret-settings.ts";
import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { invalidateGoogleDriveAccessToken } from "@/lib/meridian/storage/google-auth";
import { finishDriveConnect } from "@/lib/meridian/storage/drive-oauth";
import { signedInUserId } from "@/lib/meridian/storage/drive-route-auth.server";

/**
 * Google returns the person here after consent. The state is checked, claimed once, and bound to the person who started the
 * connection. The code is exchanged for a refresh token, which is stored encrypted for that workspace. The token is never
 * shown.
 */
export const Route = createFileRoute("/api/drive/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const headers = { "cache-control": "no-store" };
        if (url.searchParams.get("error")) {
          return new Response("Google Drive was not connected. The request was cancelled or refused.", { status: 400, headers });
        }
        const userId = await signedInUserId(request);
        if (!userId) return new Response("Sign in as the person who started the connection.", { status: 401, headers });
        const finished = await finishDriveConnect(await getSql(), {
          state: url.searchParams.get("state") ?? "",
          code: url.searchParams.get("code") ?? "",
          userId,
          origin: url.origin,
          env: process.env,
          masterKey: tokenEncryptionKey()?.trim() ?? "",
          fetch: (input, init) => globalThis.fetch(input, init),
        });
        if (!finished.ok) return new Response(finished.message, { status: finished.status, headers });
        invalidateGoogleDriveAccessToken(finished.organizationId);
        return new Response(null, { status: 302, headers: { ...headers, location: "/settings" } });
      },
    },
  },
});
