import { auth } from "@/lib/auth/server";
import { DEV_USER_ID, authConfigured } from "@/lib/auth/verify.server";

/**
 * The signed-in user for an API route request, or null. It follows the stored-asset route: the shared dev user is allowed only
 * when nothing is configured, with no sign-in and no database. Every other request without a session is refused.
 */
export async function signedInUserId(request: Request): Promise<string | null> {
  const session = await auth.api.getSession({ headers: request.headers });
  const devFallbackAllowed = !authConfigured && !process.env.DATABASE_URL?.trim();
  return session?.user?.id ?? (devFallbackAllowed ? DEV_USER_ID : null);
}
