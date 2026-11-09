import { createFileRoute } from "@tanstack/react-router";

/** The same connector for clients that send the secret as `Authorization: Bearer <secret>` instead of in the link. */
async function handle(request: Request): Promise<Response> {
  const [{ handleMcpRequest }, { mcpRouteDeps }] = await Promise.all([import("@/lib/meridian/mcp/handler"), import("@/lib/meridian/mcp/route-deps.server")]);
  return handleMcpRequest(request, { pathSecret: null }, mcpRouteDeps());
}

export const Route = createFileRoute("/api/mcp/")({
  server: {
    handlers: {
      POST: ({ request }) => handle(request),
      GET: ({ request }) => handle(request),
      DELETE: ({ request }) => handle(request),
      OPTIONS: ({ request }) => handle(request),
    },
  },
});
