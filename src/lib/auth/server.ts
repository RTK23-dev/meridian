/**
 * Better Auth for this app (server-only).
 *
 * The app runs its own Better Auth at same-origin `/api/auth/*`, so the session cookie stays on this app's origin.
 * Sign-in is email and password (`./email-password`). No provider is configured.
 *
 * Users and sessions persist in Postgres when `DATABASE_URL` is set, otherwise in the embedded PGLite database used by
 * development. Both use the Better Auth schema from `migrations/auth/0001_auth.sql`.
 *
 * NEVER import this from client code. It pulls in `pg` and the database. The browser uses `@/lib/auth/client`.
 */
import { randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { getCookie } from "@tanstack/react-start/server";
import { Pool } from "pg";
import { ensureDbReady, getPglite } from "../db";
import { emailAndPasswordEnabled } from "./email-password";
import { pgliteDialect } from "./pglite-dialect";
import { parseTrustedOrigins, trustedOriginsFor } from "./trusted-origins";

// Kick off the embedded database as soon as the auth server module loads.
void ensureDbReady();

/** Read an env var, treating empty or whitespace as unset. */
const env = (key: string): string | undefined => {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
};

// Explicit off-switch. Set `VITE_AUTH_ENABLED=false` to run as the shipped dev user.
const authDisabled = env("VITE_AUTH_ENABLED") === "false";

/** True when real sign-in is enforced. */
export const authConfigured = !authDisabled;

/** The public origin of this app. Used for the cookie domain checks and for links in email. */
const explicitBaseURL = env("BETTER_AUTH_URL");
const baseURL = explicitBaseURL ?? "http://localhost:8080";

/** Local development origins. They are trusted only outside production. */
const LOCAL_DEV_ORIGINS: string[] = [
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "http://[::1]:8080",
];

const isProduction = process.env.NODE_ENV === "production";
if (isProduction && !explicitBaseURL) {
  console.error(
    "[auth] BETTER_AUTH_URL is not set. Password-reset links would point at localhost, so set it to the public origin.",
  );
}

const extraTrustedOrigins = parseTrustedOrigins(env("MERIDIAN_TRUSTED_ORIGINS"));

const databaseUrl = env("DATABASE_URL");

// Real Postgres when `DATABASE_URL` is set. Otherwise the embedded PGLite database, through a Kysely dialect, so Better
// Auth writes to the same database as app data.
const database = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: databaseUrl.includes("sslmode=disable") ? false : undefined,
    })
  : { dialect: pgliteDialect(() => getPglite()), type: "postgres" as const };

/** Session token cookie name. */
export const SESSION_TOKEN_COOKIE = "__Host-meridian-auth.session_token";

/** Development-only signing secret, kept on globalThis so an HMR reload does not invalidate sessions. */
const globalAuthRef = globalThis as typeof globalThis & { __meridianAuthDevSecret__?: string };
function devAuthSecret(): string {
  if (isProduction) {
    console.error("[auth] BETTER_AUTH_SECRET is not set. Sessions use a per-process secret and will not survive a restart.");
  }
  globalAuthRef.__meridianAuthDevSecret__ ??= randomHex();
  return globalAuthRef.__meridianAuthDevSecret__;
}

function randomHex(): string {
  return randomBytes(32).toString("hex");
}

export const auth = betterAuth({
  baseURL,
  // Deployments inject BETTER_AUTH_SECRET. Development keeps a process-stable secret so HMR does not invalidate sessions.
  secret: env("BETTER_AUTH_SECRET") ?? devAuthSecret(),
  database,

  trustedOrigins: (request) =>
    trustedOriginsFor({
      baseURL,
      extraOrigins: extraTrustedOrigins,
      localDevOrigins: LOCAL_DEV_ORIGINS,
      isProduction,
      requestUrl: request?.url,
    }),

  // Cache the session in a short-lived signed cookie so reads skip the database.
  session: { cookieCache: { enabled: true, maxAge: 300 } },

  // Local email and password, toggled only in `./email-password`.
  ...(emailAndPasswordEnabled ? { emailAndPassword: { enabled: true } } : {}),

  // `__Host-` cookies cannot carry a Domain attribute, so a sibling app on the same parent domain cannot set this session.
  advanced: {
    useSecureCookies: false,
    defaultCookieAttributes: { secure: true, sameSite: "lax", path: "/" },
    cookies: {
      session_token: { name: SESSION_TOKEN_COOKIE },
      session_data: { name: "__Host-meridian-auth.session_data" },
      account_data: { name: "__Host-meridian-auth.account_data" },
      dont_remember: { name: "__Host-meridian-auth.dont_remember" },
    },
  },

  // Bridges Better Auth's Set-Cookie into TanStack Start responses. Keep it last.
  plugins: [tanstackStartCookies()],
});

export function readSessionToken(): string | null {
  return getCookie(SESSION_TOKEN_COOKIE) ?? null;
}
