import { useState, useSyncExternalStore, type ReactNode } from "react";
import { Link, Navigate } from "@tanstack/react-router";
import { GROK_PROVIDERS, authEnabled, signIn, signOut } from "./client";
import { hasGateSessionMarker } from "./gate-session-marker";
import { resolveSignInGateState } from "./sign-in-gate";
import { useCurrentUser, useCurrentUserState } from "./use-current-user";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, useTheme } from "@/components/ui";

const subscribeToNothing = () => () => {};
const noGateSessionOnServer = () => false;

/**
 * Auth state components — plain wrappers around `useCurrentUserState()`.
 *
 * With auth on, visitors are signed out until they authenticate — in the sandbox
 * live preview too, which does real sign-in. The shared dev user appears only
 * when auth is disabled (`VITE_AUTH_ENABLED=false`, the shipped default).
 * While the session is still resolving, gates that care about signed-out state
 * render nothing so there's no signed-out flash on hard reload.
 */

/** Where `RedirectToSignIn` sends signed-out visitors. Create this route. */
export const SIGN_IN_PATH = "/login";

/** Render children only when a user is present (real session, or the disabled-auth dev user). */
export function SignedIn({ children }: { children: ReactNode }) {
  const { user } = useCurrentUserState();
  return user ? <>{children}</> : null;
}

/**
 * Render children only once we KNOW the visitor is signed out (`isPending` has
 * cleared and there is no user). Hidden while the session is still loading.
 */
export function SignedOut({ children }: { children: ReactNode }) {
  const { user, isPending } = useCurrentUserState();
  if (isPending || user) return null;
  return <>{children}</>;
}

/**
 * Client-side redirect to the sign-in route (TanStack `<Navigate>` — NOT a full
 * `window.location` reload). A hard navigation re-bootstraps the SPA and re-runs
 * session loading, which feels like a second "Loading…" on /login.
 *
 * Guard routes by waiting out `isPending` first (see `use-current-user`), then
 * render this.
 */
export function RedirectToSignIn({ to = SIGN_IN_PATH }: { to?: string }) {
  return <Navigate to={to} />;
}

export function SignInGate({
  children,
  fallback,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { user, isPending } = useCurrentUserState();
  const state = resolveSignInGateState({ isPending, hasUser: user !== null });
  if (state === "pending") return null;
  if (state === "signed_in") return <>{children}</>;
  return <>{fallback ?? <SignInButtons />}</>;
}

export function SignInButtons() {
  return (
    <div className="flex w-full max-w-sm flex-col gap-2">
      {GROK_PROVIDERS.map((p) => (
        <button
          key={p.providerId}
          type="button"
          onClick={() => signIn(p.providerId, { callbackURL: "/" })}
          className="w-full cursor-pointer rounded-md border border-neutral-300 px-4 py-2 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Continue with {p.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Signed-in account menu for the top bar: identity, appearance, notification preferences and sign-out. Sign-out is only
 * shown when auth is enabled (the disabled-auth dev user has nothing to sign out of) and the session is not
 * gate-materialized: behind the gate the next request signs the viewer straight back in, so a sign-out control there
 * is a broken loop.
 */
export function UserButton() {
  const user = useCurrentUser();
  const { theme, setTheme } = useTheme();
  // Sign-out can take a moment (and can fail when deployed), so the menu item
  // shows it is working and cannot be fired twice.
  const [signingOut, setSigningOut] = useState(false);
  const gateSession = useSyncExternalStore(
    subscribeToNothing,
    hasGateSessionMarker,
    noGateSessionOnServer,
  );
  if (!user) return null;
  const label = user.displayName ?? user.primaryEmail ?? "Account";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Account and appearance settings" title={label} className="flex min-h-10 min-w-10 items-center gap-2 rounded-md px-1 text-sm text-fg hover:bg-surface-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11">
          {user.profileImageUrl ? (
            <img src={user.profileImageUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
          ) : (
            <span aria-hidden="true" className="grid h-8 w-8 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-fg">
              {label.charAt(0).toUpperCase()}
            </span>
          )}
          <span className="hidden max-w-32 truncate font-medium xl:inline">{label}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label="Account">
        <div className="px-2 py-1.5">
          <p className="truncate text-sm font-semibold text-fg">{label}</p>
          {user.primaryEmail && user.primaryEmail !== label ? <p className="truncate text-xs text-fg-muted">{user.primaryEmail}</p> : null}
        </div>
        <DropdownMenuItem asChild>
          <Link to="/notifications">Notification preferences</Link>
        </DropdownMenuItem>
        <p className="px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-fg-muted">Appearance</p>
        {(["system", "light", "dark"] as const).map((choice) => <DropdownMenuItem key={choice} role="menuitemradio" aria-checked={theme === choice} onSelect={() => setTheme(choice)}>{choice[0].toUpperCase() + choice.slice(1)}{theme === choice ? " (current)" : ""}</DropdownMenuItem>)}
        {authEnabled && !gateSession ? <DropdownMenuItem disabled={signingOut} onSelect={() => { setSigningOut(true); void signOut().catch(() => setSigningOut(false)); }}>{signingOut ? "Signing out…" : "Sign out"}</DropdownMenuItem> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
