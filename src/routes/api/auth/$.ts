import { createFileRoute } from "@tanstack/react-router";
import { auth } from "@/lib/auth/server";
import { attemptedAccount, authAttemptKey, authFailureResponse, enforceNamedLimit } from "@/lib/meridian/security/limits";

async function handleAuth(request: Request) {
  // Only apply strict auth attempt rate limiting on authentication mutations
  // (sign-in, sign-up, password reset, etc.), while allowing read-only session checks.
  const isReadSession = request.method === "GET" && (request.url.includes("session") || request.url.includes("get-session"));
  if (!isReadSession) {
    try {
      await enforceNamedLimit("auth", authAttemptKey(request, await attemptedAccount(request)));
    } catch (error) {
      return authFailureResponse(error);
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
