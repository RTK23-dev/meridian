/**
 * Connecting and disconnecting a workspace's Google Drive: the OAuth authorization-code flow, the state that binds one attempt
 * to one person and one workspace, and disconnecting (remove the stored token, then ask Google to revoke it).
 *
 * The consent is for drive.file only. The refresh token is stored encrypted (drive-connection-store.ts). The access token is
 * never stored. No function here returns a token, and no error message carries one: a failed exchange or revocation reports
 * the HTTP status and Google's short error code only.
 */
import { createHash, randomBytes } from "node:crypto";
import { hasRole, isRole } from "../access.ts";
import type { Sql } from "../learning/store.ts";
import {
  DRIVE_CALLBACK_PATH,
  DRIVE_FILE_SCOPE,
  GOOGLE_AUTHORIZATION_URL,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
} from "./drive-oauth-config.ts";
import { removeDriveRefreshToken, saveDriveRefreshToken } from "./drive-connection-store.ts";

/** A connection link is good for ten minutes. */
export const DRIVE_STATE_TTL_MS = 10 * 60 * 1000;

type Env = { [key: string]: string | undefined };

export type DriveOauthClient = { ready: true; clientId: string; clientSecret: string } | { ready: false; missing: string[] };

/** The OAuth client the deployment configured. Names of missing settings only. */
export function driveOauthClient(env: Env): DriveOauthClient {
  const clientId = env.GOOGLE_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
  if (clientId && clientSecret) return { ready: true, clientId, clientSecret };
  return { ready: false, missing: [...(clientId ? [] : ["GOOGLE_CLIENT_ID"]), ...(clientSecret ? [] : ["GOOGLE_CLIENT_SECRET"])] };
}

export function driveCallbackUrl(origin: string): string {
  return `${origin.replace(/\/$/, "")}${DRIVE_CALLBACK_PATH}`;
}

export function buildDriveAuthorizationUrl(input: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL(GOOGLE_AUTHORIZATION_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", DRIVE_FILE_SCOPE);
  url.searchParams.set("access_type", "offline");
  // Consent every time, so Google returns a refresh token even when this client was authorized before.
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", input.state);
  return url.toString();
}

export function newDriveOauthState(): string {
  return randomBytes(32).toString("base64url");
}

/** The state is stored only as this hash. A database read does not reveal a state that could finish a connection. */
export function hashDriveOauthState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

export type DriveFlowResult<T> = ({ ok: true } & T) | { ok: false; status: number; message: string };

/** Admin only. A member, a viewer, or a person outside the workspace is refused. */
export async function adminGate(sql: Sql, userId: string, organizationId: string): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const rows = await sql<{ role: string }>`
    select role from memberships where user_id = ${userId} and organization_id = ${organizationId} limit 1
  `;
  const role = rows[0]?.role;
  if (!role || !isRole(role)) return { ok: false, status: 403, message: "That workspace is not available to you." };
  if (!hasRole(role, "admin")) return { ok: false, status: 403, message: "Only an admin can connect or disconnect Google Drive." };
  return { ok: true };
}

const NOT_AVAILABLE = "This connection link is missing, already used, or expired. Start the connection again from Settings.";

/** Begins a connection: records the state for this person and workspace, and returns Google's consent URL. */
export async function startDriveConnect(
  sql: Sql,
  input: { organizationId: string; userId: string; origin: string; env: Env; now: number; newState?: () => string },
): Promise<DriveFlowResult<{ url: string }>> {
  const gate = await adminGate(sql, input.userId, input.organizationId);
  if (!gate.ok) return gate;
  const client = driveOauthClient(input.env);
  if (!client.ready) {
    return {
      ok: false,
      status: 400,
      message: `Connecting Google Drive needs ${client.missing.join(" and ")} set in the deployment environment. Nothing was connected.`,
    };
  }
  const state = (input.newState ?? newDriveOauthState)();
  const expiresAt = new Date(input.now + DRIVE_STATE_TTL_MS).toISOString();
  // Old states are removed as new ones are made, so the table holds only recent attempts.
  await sql`delete from drive_oauth_states where expires_at < now() - interval '1 day'`;
  await sql`
    insert into drive_oauth_states (state_hash, organization_id, user_id, expires_at)
    values (${hashDriveOauthState(state)}, ${input.organizationId}, ${input.userId}, ${expiresAt})
  `;
  return {
    ok: true,
    url: buildDriveAuthorizationUrl({ clientId: client.clientId, redirectUri: driveCallbackUrl(input.origin), state }),
  };
}

/** Google's reason for a refused exchange: the HTTP status and its short error code, never the body. */
function exchangeFailureReason(status: number, errorCode: unknown): string {
  const code = typeof errorCode === "string" && /^[a-z_]{1,40}$/.test(errorCode) ? ` (${errorCode})` : "";
  return `Google refused the connection: HTTP ${status}${code}.`;
}

/** Exchanges an authorization code for the refresh token. The access token in Google's reply is not kept. */
export async function exchangeDriveCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  fetch: typeof fetch;
}): Promise<{ ok: true; refreshToken: string | null } | { ok: false; message: string }> {
  let response: Response;
  try {
    response = await input.fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: input.code,
        client_id: input.clientId,
        client_secret: input.clientSecret,
        redirect_uri: input.redirectUri,
        grant_type: "authorization_code",
      }),
    });
  } catch {
    return { ok: false, message: "Google could not be reached to finish the connection. Nothing was connected." };
  }
  const json = (await response.json().catch(() => null)) as { refresh_token?: unknown; error?: unknown } | null;
  if (!response.ok) return { ok: false, message: exchangeFailureReason(response.status, json?.error) };
  return { ok: true, refreshToken: typeof json?.refresh_token === "string" && json.refresh_token ? json.refresh_token : null };
}

/**
 * Finishes a connection from Google's redirect. The state is checked and claimed before the code is exchanged, so the same
 * state cannot finish twice. The person who started it must be the one signed in now, and still an admin.
 */
export async function finishDriveConnect(
  sql: Sql,
  input: {
    state: string;
    code: string;
    userId: string;
    origin: string;
    env: Env;
    masterKey: string;
    fetch: typeof fetch;
  },
): Promise<DriveFlowResult<{ organizationId: string }>> {
  if (!input.masterKey.trim()) {
    return { ok: false, status: 500, message: "TOKEN_ENCRYPTION_KEY is not configured. The Drive connection was not stored." };
  }
  const client = driveOauthClient(input.env);
  if (!client.ready) {
    return { ok: false, status: 400, message: `Connecting Google Drive needs ${client.missing.join(" and ")} set in the deployment environment. Nothing was connected.` };
  }
  if (!input.state || !input.code) {
    return { ok: false, status: 400, message: "Google's reply is missing its state or code. Start the connection again from Settings." };
  }
  const hash = hashDriveOauthState(input.state);
  const rows = await sql<{ organization_id: string; user_id: string }>`
    select organization_id, user_id from drive_oauth_states
    where state_hash = ${hash} and used_at is null and expires_at > now()
    limit 1
  `;
  const row = rows[0];
  if (!row) return { ok: false, status: 400, message: NOT_AVAILABLE };
  if (row.user_id !== input.userId) {
    return { ok: false, status: 403, message: "Only the person who started this connection can finish it." };
  }
  const gate = await adminGate(sql, input.userId, row.organization_id);
  if (!gate.ok) return gate;

  // Claim the state. A concurrent or repeated request finds it used and stops here.
  const claimed = await sql<{ state_hash: string }>`
    update drive_oauth_states set used_at = now()
    where state_hash = ${hash} and used_at is null and expires_at > now()
    returning state_hash
  `;
  if (claimed.length === 0) return { ok: false, status: 400, message: NOT_AVAILABLE };

  const exchanged = await exchangeDriveCode({
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    code: input.code,
    redirectUri: driveCallbackUrl(input.origin),
    fetch: input.fetch,
  });
  if (!exchanged.ok) return { ok: false, status: 502, message: `${exchanged.message} Nothing was connected.` };
  if (!exchanged.refreshToken) {
    return {
      ok: false,
      status: 502,
      message: "Google did not return a refresh token, so nothing was connected. Remove Meridian from your Google Account's connected apps, then connect again.",
    };
  }
  await saveDriveRefreshToken(sql, {
    organizationId: row.organization_id,
    refreshToken: exchanged.refreshToken,
    connectedByUserId: input.userId,
    masterKey: input.masterKey,
  });
  return { ok: true, organizationId: row.organization_id };
}

export type RevocationResult = { revoked: true } | { revoked: false; reason: string };

/** Asks Google to revoke a refresh token. Google also revokes the access tokens derived from it. */
export async function revokeDriveRefreshToken(input: { refreshToken: string; fetch: typeof fetch }): Promise<RevocationResult> {
  try {
    const response = await input.fetch(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: input.refreshToken }),
    });
    if (response.ok) return { revoked: true };
    return { revoked: false, reason: `Google did not confirm the revocation (HTTP ${response.status}).` };
  } catch {
    return { revoked: false, reason: "Google could not be reached to revoke the connection." };
  }
}

export type DisconnectResult =
  | { ok: true; status: "not_connected"; revocation: "not_attempted"; detail: string }
  | { ok: true; status: "disconnected"; revocation: "revoked" | "revocation_failed" | "not_attempted"; detail: string }
  | { ok: false; status: number; message: string };

/**
 * Disconnects the workspace. The stored token is removed first, so Meridian stops using it at once. Then Google is asked to
 * revoke it. If Google does not confirm, the result says so, and says what the person should do.
 */
export async function disconnectDriveWorkspace(
  sql: Sql,
  input: { organizationId: string; userId: string; masterKey: string; fetch: typeof fetch; invalidate: () => void },
): Promise<DisconnectResult> {
  const gate = await adminGate(sql, input.userId, input.organizationId);
  if (!gate.ok) return gate;
  const removed = await removeDriveRefreshToken(sql, { organizationId: input.organizationId, masterKey: input.masterKey });
  input.invalidate();
  if (!removed.removed) {
    return { ok: true, status: "not_connected", revocation: "not_attempted", detail: "Google Drive is not connected to this workspace. Nothing to disconnect." };
  }
  const manualStep = "Remove Meridian from your Google Account's connected apps to be sure.";
  if (!removed.refreshToken) {
    return {
      ok: true,
      status: "disconnected",
      revocation: "not_attempted",
      detail: `Meridian no longer uses this workspace's Google Drive connection. Google was not asked to revoke it: ${removed.reason ?? "the stored token could not be read."} ${manualStep}`,
    };
  }
  const revoked = await revokeDriveRefreshToken({ refreshToken: removed.refreshToken, fetch: input.fetch });
  if (revoked.revoked) {
    return { ok: true, status: "disconnected", revocation: "revoked", detail: "Google Drive is disconnected, and Google has revoked the connection." };
  }
  return {
    ok: true,
    status: "disconnected",
    revocation: "revocation_failed",
    detail: `Meridian no longer uses this workspace's Google Drive connection, but ${revoked.reason} ${manualStep}`,
  };
}
