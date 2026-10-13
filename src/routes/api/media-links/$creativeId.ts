import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { serveSignedCreative } from "@/lib/meridian/storage/signed-creative";

/**
 * The public route a platform fetches a creative's file from. It has no session check: the signed link (signature and expiry in
 * the query) is the authorisation, and serveSignedCreative checks it before any read.
 */
export const Route = createFileRoute("/api/media-links/$creativeId")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        serveSignedCreative({
          request,
          creativeId: params.creativeId,
          getSql,
          loadArtifactFiles: async () => (await import("@/lib/meridian/storage/artifact-drive")).defaultArtifactDrive(),
          logError: (message, detail) => console.error(message, detail),
        }),
    },
  },
});
