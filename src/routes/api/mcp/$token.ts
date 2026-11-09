import { createFileRoute } from "@tanstack/react-router";

/**
 * Meridian's MCP connector, reached by a secret connector link (Settings, Connections, Claude connector). The secret in the path is the
 * authorisation; the handler checks it, and the link maker's role, on every call. See lib/meridian/mcp.
 */
async function handle(request: Request, token: string): Promise<Response> {
  const [{ handleMcpRequest }, { mcpRouteDeps }] = await Promise.all([import("@/lib/meridian/mcp/handler"), import("@/lib/meridian/mcp/route-deps.server")]);
  return handleMcpRequest(request, { pathSecret: token }, mcpRouteDeps());
}

export const Route = createFileRoute("/api/mcp/$token")({
  server: {
    handlers: {
      POST: ({ request, params }) => handle(request, params.token),
      GET: ({ request, params }) => handle(request, params.token),
      DELETE: ({ request, params }) => handle(request, params.token),
      OPTIONS: ({ request, params }) => handle(request, params.token),
    },
  },
});
