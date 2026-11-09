import { createFileRoute } from "@tanstack/react-router";

/**
 * A file a connector made, by its signed link (an hour). The signature and expiry are the authorisation and are checked before anything is
 * read. The bytes come from Meridian's storage layer; a file that cannot be read is a 404, never a guess.
 */
export const Route = createFileRoute("/api/mcp-files/$fileId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const [{ serveMcpFile }, { getSql }] = await Promise.all([import("@/lib/meridian/mcp/serve-file.server"), import("@/lib/db")]);
        return serveMcpFile(request, params.fileId, { getSql, env: process.env });
      },
    },
  },
});
