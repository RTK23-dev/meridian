/**
 * Google Drive authentication for artifact storage.
 *
 * Drive is the artifact store only: it holds artifact and export bytes, and Postgres holds every record about them. Access
 * tokens are kept in memory for this process. They are never written to the database, returned to a browser, or logged.
 *
 * A Drive call uses the first credential that applies:
 *   1. the workspace's own Drive connection (its refresh token, stored encrypted; see drive-connection-store.ts), when the
 *      call names a workspace that connected Drive from the settings screen;
 *   2. the deployment's service account (GOOGLE_SERVICE_ACCOUNT_KEY);
 *   3. the deployment's OAuth refresh token (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN).
 * A workspace whose connection exists but cannot be used does not fall through to 2 or 3. Its files must not be written to
 * another Google account, so the call fails with a reason instead.
 *
 * This is separate from the Google sign-in on the Integrations screen (oauth/flow.server.ts). That flow requests the Google
 * Ads scope and does not authorize Drive. Never fabricates tokens when credentials are unset.
 */
import { createSign } from "node:crypto";
import type { WorkspaceRefreshTokenLookup } from "./drive-connection-store.ts";
import { GOOGLE_TOKEN_URL } from "./drive-oauth-config.ts";

export type GoogleAuthStatus = {
  configured: boolean;
  type: "oauth_refresh" | "service_account" | "none";
  detail: string;
  /** Deployment settings still missing for the service account or OAuth refresh options. Names only, never values. */
  missing: string[];
};

export type DriveCredentialSource = "workspace" | "service_account" | "oauth_refresh";

export type DriveAccess =
  | { ok: true; token: string; source: DriveCredentialSource }
  | { ok: false; source: "none" | "failed"; reason: string; missing: string[] };

/** The environment the auth reads. process.env satisfies it; tests pass a plain object. */
type AuthEnv = { [key: string]: string | undefined };

export type GoogleDriveAuthDeps = {
  /** Read at each call, so a test can change the environment between calls. */
  env: () => AuthEnv;
  fetch: typeof fetch;
  now: () => number;
  lookupWorkspaceRefreshToken: (organizationId: string) => Promise<WorkspaceRefreshTokenLookup>;
  /** Receives fixed messages only. Never a token, a key, or a response body. */
  log: (message: string) => void;
};

type CachedToken = { accessToken: string; expiresAt: number };

const DEPLOYMENT_NAMES = ["GOOGLE_SERVICE_ACCOUNT_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"] as const;
const SERVICE_ACCOUNT_SCOPE = "https://www.googleapis.com/auth/drive";
const EXPIRY_MARGIN_MS = 60_000;

function settingValue(env: AuthEnv, name: string): string {
  return env[name]?.trim() ?? "";
}

function oauthRefreshReady(env: AuthEnv): boolean {
  return Boolean(
    settingValue(env, "GOOGLE_CLIENT_ID") && settingValue(env, "GOOGLE_CLIENT_SECRET") && settingValue(env, "GOOGLE_REFRESH_TOKEN"),
  );
}

function deploymentMissing(env: AuthEnv): string[] {
  return DEPLOYMENT_NAMES.filter((name) => !settingValue(env, name));
}

/** The deployment-level status: the service account or OAuth refresh credentials in the environment. Never a token. */
export function getGoogleDriveAuthStatus(env: AuthEnv = process.env): GoogleAuthStatus {
  if (settingValue(env, "GOOGLE_SERVICE_ACCOUNT_KEY")) {
    return { configured: true, type: "service_account", detail: "Google Service Account key is configured.", missing: [] };
  }
  if (oauthRefreshReady(env)) {
    return { configured: true, type: "oauth_refresh", detail: "Google OAuth 2.0 refresh credentials are configured.", missing: [] };
  }
  return {
    configured: false,
    type: "none",
    detail: "Neither GOOGLE_SERVICE_ACCOUNT_KEY nor GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN is set. Google Drive is not connected.",
    missing: deploymentMissing(env),
  };
}

/** Reason text for a call that has no credential at all. It names what would connect Drive. */
function notConnectedReason(missing: string[]): string {
  return `Google Drive is not connected. Connect it from Settings, or set ${missing.join(", ")} in the deployment environment.`;
}

/**
 * The resolver with its dependencies injected. The module-level functions below use the real environment, database and
 * fetch. Tests build their own resolver with stubs.
 */
export function createGoogleDriveAuth(deps: GoogleDriveAuthDeps) {
  const cache = new Map<string, CachedToken>();

  function cached(key: string): string | null {
    const hit = cache.get(key);
    return hit && hit.expiresAt > deps.now() + EXPIRY_MARGIN_MS ? hit.accessToken : null;
  }

  function remember(key: string, accessToken: string, expiresInSeconds: number | undefined): void {
    cache.set(key, { accessToken, expiresAt: deps.now() + (expiresInSeconds ?? 3600) * 1000 });
  }

  /** One request to Google's token endpoint. Errors carry the HTTP status and Google's short error code, never the body. */
  async function requestToken(
    body: URLSearchParams,
    label: string,
  ): Promise<{ token: string; expiresIn: number | undefined } | { error: string }> {
    let response: Response;
    try {
      response = await deps.fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch {
      return { error: `${label} could not reach Google.` };
    }
    const json = (await response.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown; error?: unknown } | null;
    if (!response.ok || typeof json?.access_token !== "string" || !json.access_token) {
      const code = typeof json?.error === "string" && /^[a-z_]{1,40}$/.test(json.error) ? ` (${json.error})` : "";
      return { error: `${label} failed: HTTP ${response.status}${code}.` };
    }
    return { token: json.access_token, expiresIn: typeof json.expires_in === "number" ? json.expires_in : undefined };
  }

  /** A signed JWT assertion for the service account. The key is parsed here and never echoed in an error. */
  function serviceAccountAssertion(keyJson: string): string | null {
    let creds: { client_email?: unknown; private_key?: unknown };
    try {
      creds = JSON.parse(keyJson) as { client_email?: unknown; private_key?: unknown };
    } catch {
      return null;
    }
    if (typeof creds.client_email !== "string" || typeof creds.private_key !== "string") return null;
    const nowSec = Math.floor(deps.now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
      iss: creds.client_email,
      scope: SERVICE_ACCOUNT_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      exp: nowSec + 3600,
      iat: nowSec,
    })}`;
    try {
      const signer = createSign("RSA-SHA256");
      signer.update(unsigned);
      return `${unsigned}.${signer.sign(creds.private_key, "base64url")}`;
    } catch {
      return null;
    }
  }

  function fail(source: "none" | "failed", reason: string, missing: string[] = []): DriveAccess {
    return { ok: false, source, reason, missing };
  }

  async function fromWorkspace(organizationId: string, refreshToken: string): Promise<DriveAccess> {
    const env = deps.env();
    const clientId = settingValue(env, "GOOGLE_CLIENT_ID");
    const clientSecret = settingValue(env, "GOOGLE_CLIENT_SECRET");
    if (!clientId || !clientSecret) {
      return fail(
        "failed",
        "This workspace has connected Google Drive, but GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set, so the connection cannot be used. Nothing was written to another account.",
      );
    }
    const result = await requestToken(
      new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
      "Google Drive refresh for this workspace",
    );
    if ("error" in result) {
      deps.log("workspace Drive token refresh failed");
      return fail("failed", `${result.error} Nothing was written to another account. Disconnect and connect Drive again if this continues.`);
    }
    remember(`workspace:${organizationId}`, result.token, result.expiresIn);
    return { ok: true, token: result.token, source: "workspace" };
  }

  async function fromServiceAccount(keyJson: string): Promise<DriveAccess> {
    const cacheKey = "service_account";
    const hit = cached(cacheKey);
    if (hit) return { ok: true, token: hit, source: "service_account" };
    const assertion = serviceAccountAssertion(keyJson);
    if (!assertion) {
      deps.log("the service account key could not be read");
      return fail("failed", "The Google service account key could not be read. Nothing was written.");
    }
    const result = await requestToken(
      new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
      "Google service account token exchange",
    );
    if ("error" in result) {
      deps.log("service account token exchange failed");
      return fail("failed", `${result.error} Nothing was written.`);
    }
    remember(cacheKey, result.token, result.expiresIn);
    return { ok: true, token: result.token, source: "service_account" };
  }

  async function fromOauthRefresh(env: AuthEnv): Promise<DriveAccess> {
    const cacheKey = "oauth_refresh";
    const hit = cached(cacheKey);
    if (hit) return { ok: true, token: hit, source: "oauth_refresh" };
    const result = await requestToken(
      new URLSearchParams({
        client_id: settingValue(env, "GOOGLE_CLIENT_ID"),
        client_secret: settingValue(env, "GOOGLE_CLIENT_SECRET"),
        refresh_token: settingValue(env, "GOOGLE_REFRESH_TOKEN"),
        grant_type: "refresh_token",
      }),
      "Google OAuth refresh",
    );
    if ("error" in result) {
      deps.log("deployment OAuth token refresh failed");
      return fail("failed", `${result.error} Nothing was written.`);
    }
    remember(cacheKey, result.token, result.expiresIn);
    return { ok: true, token: result.token, source: "oauth_refresh" };
  }

  /** The credential for a call, by the precedence in the header comment. A failure never carries a token. */
  async function access(organizationId?: string): Promise<DriveAccess> {
    const env = deps.env();
    const workspaceId = organizationId?.trim() ?? "";
    if (workspaceId) {
      const hit = cached(`workspace:${workspaceId}`);
      if (hit) return { ok: true, token: hit, source: "workspace" };
      const lookup = await deps.lookupWorkspaceRefreshToken(workspaceId);
      if (lookup.status === "unreadable") return fail("failed", `${lookup.reason} Nothing was written to another account.`);
      if (lookup.status === "found") return fromWorkspace(workspaceId, lookup.refreshToken);
    }
    const serviceAccount = settingValue(env, "GOOGLE_SERVICE_ACCOUNT_KEY");
    if (serviceAccount) return fromServiceAccount(serviceAccount);
    if (oauthRefreshReady(env)) return fromOauthRefresh(env);
    const missing = deploymentMissing(env);
    return fail("none", notConnectedReason(missing), missing);
  }

  /**
   * Drops cached access tokens. With no workspace, every cached token goes, so the next call mints one. That is the path after
   * Drive answers 401. With a workspace, only that workspace's token goes, which is what connecting and disconnecting need.
   */
  function invalidate(organizationId?: string): void {
    const workspaceId = organizationId?.trim() ?? "";
    if (workspaceId) cache.delete(`workspace:${workspaceId}`);
    else cache.clear();
  }

  return { access, invalidate };
}

const defaultAuth = createGoogleDriveAuth({
  env: () => process.env,
  fetch: (input, init) => globalThis.fetch(input, init),
  now: () => Date.now(),
  lookupWorkspaceRefreshToken: async (organizationId) => {
    const { getSql } = await import("../../db.ts");
    const { lookupWorkspaceRefreshToken } = await import("./drive-connection-store.ts");
    return lookupWorkspaceRefreshToken(await getSql(), organizationId, process.env.TOKEN_ENCRYPTION_KEY ?? "");
  },
  log: (message) => console.error(`[google-auth] ${message}`),
});

/** The credential a Drive call for this workspace uses, or the reason there is none. */
export function resolveDriveAccess(organizationId?: string): Promise<DriveAccess> {
  return defaultAuth.access(organizationId);
}

/** A current access token for the workspace's credential, or null. For callers that need only the token. */
export async function getGoogleDriveAccessToken(organizationId?: string): Promise<string | null> {
  const access = await resolveDriveAccess(organizationId);
  return access.ok ? access.token : null;
}

/** Drops cached tokens. Called with no workspace after a 401, and with a workspace after it connects or disconnects. */
export function invalidateGoogleDriveAccessToken(organizationId?: string): void {
  defaultAuth.invalidate(organizationId);
}
