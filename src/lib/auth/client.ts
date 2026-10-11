import { runSignOut } from "../../../scripts/sign-out-plan.mjs";

/**
 * Better Auth client for this React app (browser-side). It talks to the app's own `/api/auth/*`.
 *
 * Sign in with `authClient.signIn.email` (see `components/settings/email-auth-form.tsx`). Sign out with `signOut()` below,
 * which runs the shared sign-out sequence, not `authClient.signOut()` directly.
 */
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();

/** True when sign-in is enforced. Set `VITE_AUTH_ENABLED=false` for the shipped dev user (see `use-current-user`). */
export const authEnabled = import.meta.env.VITE_AUTH_ENABLED !== "false";

/**
 * Sign out of this app's session, then redirect. Rejects when the server never confirms, because the session is an
 * HttpOnly cookie only the server can clear. A redirect in that case would report a sign-out that did not happen.
 */
export async function signOut(redirectTo = "/"): Promise<void> {
  await runSignOut({
    livePreview: false,
    hasBearer: false,
    // Better Auth resolves with `{ error }` instead of rejecting, so surface a failed response as a rejection.
    requestSignOut: async () => {
      const { error } = await authClient.signOut();
      if (error) throw new Error(error.message ?? "Sign-out failed");
    },
    clearToken: () => {},
    redirect: () => {
      window.location.href = redirectTo;
    },
  });
}
