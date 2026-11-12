import { createFileRoute } from "@tanstack/react-router";

/** Takes a finished file from a coding agent, by its signed upload address (15 minutes). The signature and expiry are checked first. */
export const Route = createFileRoute("/api/mcp-upload/$token")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const [{ acceptMcpUpload }, { getSql }] = await Promise.all([import("@/lib/meridian/mcp/serve-upload.server"), import("@/lib/db")]);
        return acceptMcpUpload(request, params.token, { getSql, env: process.env });
      },
      PUT: async ({ request, params }) => {
        const [{ acceptMcpUpload }, { getSql }] = await Promise.all([import("@/lib/meridian/mcp/serve-upload.server"), import("@/lib/db")]);
        return acceptMcpUpload(request, params.token, { getSql, env: process.env });
      },
    },
  },
});
