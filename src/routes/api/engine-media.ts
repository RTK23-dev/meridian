import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { engineObjectStore, serveEngineMedia } from "@/lib/meridian/storage/engine-media-link";

/**
 * The public route Shotstack fetches an engine object's source from (Bible 6.11). It has no session check: the signed link (the
 * organization, the object key, the expiry and the signature in the query) is the authorisation, and serveEngineMedia checks it
 * before any read. The link is valid for 15 minutes.
 */
export const Route = createFileRoute("/api/engine-media")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        serveEngineMedia({
          request,
          getSql,
          objectStore: engineObjectStore,
          logError: (message, detail) => console.error(message, detail),
        }),
    },
  },
});
