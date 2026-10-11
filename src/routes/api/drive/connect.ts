import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { startDriveConnect } from "@/lib/meridian/storage/drive-oauth";
import { signedInUserId } from "@/lib/meridian/storage/drive-route-auth.server";

/**
 * Starts a workspace's Google Drive connection. The signed-in person must be an admin of the workspace named in the query.
 * The reply redirects to Google's consent screen. The state it records is bound to this person and workspace, and expires.
 */
export const Route = createFileRoute("/api/drive/connect")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const organizationId = url.searchParams.get("organizationId")?.trim() ?? "";
        const headers = { "cache-control": "no-store" };
        if (!organizationId) return new Response("A workspace is required.", { status: 400, headers });
        const userId = await signedInUserId(request);
        if (!userId) return new Response("Sign in to connect Google Drive.", { status: 401, headers });
        const started = await startDriveConnect(await getSql(), {
          organizationId,
          userId,
          origin: url.origin,
          env: process.env,
          now: Date.now(),
        });
        if (!started.ok) return new Response(started.message, { status: started.status, headers });
        return new Response(null, { status: 302, headers: { ...headers, location: started.url } });
      },
    },
  },
});
