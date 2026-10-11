import { useEffect, useState } from "react";
import { createAuthClient } from "better-auth/react";
import { runSignOut } from "../../../scripts/sign-out-plan.mjs";
import { SIGN_IN_PROVIDERS, type SignInProviderId } from "./providers";

/**
 * Better Auth client for this React app (browser-side). It talks to the app's own `/api/auth/*`.
 *
 * Sign out with `signOut()` below, which runs the shared sign-out sequence, not `authClient.signOut()` directly.
 */
export const authClient = createAuthClient();

/** True when sign-in is enforced. Set `VITE_AUTH_ENABLED=false` for the shipped dev user (see `use-current-user`). */
export const authEnabled = import.meta.env.VITE_AUTH_ENABLED !== "false";

export { SIGN_IN_PROVIDERS };
export type { SignInProviderId };

export type SignInOptions = Record<SignInProviderId, boolean>;

/**
 * Which sign-in providers the server has configured. Until the answer arrives, and when it cannot be read, every provider
 * counts as unavailable. An unconfigured provider is shown as unavailable, never as a working button.
 */
export function useSignInOptions(): { loaded: boolean; options: SignInOptions } {
  const [state, setState] = useState<{ loaded: boolean; options: SignInOptions }>({
    loaded: false,
    options: { google: false },
  });
  useEffect(() => {
    let cancelled = false;
    fetch("/api/sign-in-options", { credentials: "same-origin" })
      .then((response) => (response.ok ? (response.json() as Promise<SignInOptions>) : Promise.reject(new Error(String(response.status)))))
      .then((options) => {
        if (!cancelled) setState({ loaded: true, options: { google: options.google === true } });
      })
      .catch(() => {
        if (!cancelled) setState({ loaded: true, options: { google: false } });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

/**
 * Start sign-in with one provider. The browser is sent to the provider, and it returns to `callbackURL` with a session
 * cookie. Errors reject with the server's message.
 */
export async function signIn(
  providerId: SignInProviderId,
  opts: { callbackURL?: string; errorCallbackURL?: string } = {},
): Promise<void> {
  const callbackURL = opts.callbackURL ?? "/";
  const errorCallbackURL = opts.errorCallbackURL ?? "/";
  const { data, error } = await authClient.signIn.social({ provider: providerId, callbackURL, errorCallbackURL });
  if (error) throw new Error(error.message ?? "Sign-in failed");
  if (data?.url && typeof window !== "undefined") window.location.href = data.url;
}

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
