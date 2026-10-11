/**
 * The sign-in providers this app offers, besides email and password.
 *
 * Dependency-free so the browser can import it without the server-only auth instance. The server registers each
 * provider as a Better Auth social provider only when its credentials are set (see `server.ts`). The browser asks the
 * server which ones are configured, so a button is never shown for a provider that cannot work.
 */
export const SIGN_IN_PROVIDERS = [{ id: "google", label: "Google" }] as const;

export type SignInProviderId = (typeof SIGN_IN_PROVIDERS)[number]["id"];
