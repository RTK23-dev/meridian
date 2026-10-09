import { createFileRoute } from "@tanstack/react-router";
import { auth } from "@/lib/auth/server";
import { authLimit, clientKey, refuseIfLimited, RATE_LIMIT_MESSAGE } from "@/lib/meridian/security/limits";

function handleAuth(request: Request) {
  // Only apply strict auth attempt rate limiting on authentication mutations
  // (sign-in, sign-up, password reset, etc.), while allowing read-only session checks.
  const isReadSession = request.method === "GET" && (request.url.includes("session") || request.url.includes("get-session"));
  if (!isReadSession) {
    try {
      refuseIfLimited(authLimit, clientKey(request));
    } catch (error) {
      const message = error instanceof Error ? error.message : RATE_LIMIT_MESSAGE;
      return new Response(JSON.stringify({ message }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }
  }
  return auth.handler(request);
}

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => handleAuth(request),
      POST: ({ request }) => handleAuth(request),
    },
  },
});
