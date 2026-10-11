/**
 * A workspace's Google Drive connection, as Postgres holds it. The Google refresh token is stored encrypted in credential_vault
 * under DRIVE_CREDENTIAL_TYPE, one row per workspace. Every statement filters by organization_id. The token is returned only
 * to the auth resolver (google-auth.ts) and to the revocation on disconnect. No function here returns it to a page.
 */
import { randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import { isoTimestamp } from "../observability/timestamps.ts";
import { decryptPayload, encryptPayload } from "../vault/crypto.ts";
import { DRIVE_FILE_SCOPE } from "./drive-oauth-config.ts";

export const DRIVE_CREDENTIAL_TYPE = "storage:google_drive";

/** What the auth resolver needs about a workspace's connection. A token is found, absent, or present but unusable. */
export type WorkspaceRefreshTokenLookup =
  | { status: "none" }
  | { status: "found"; refreshToken: string }
  | { status: "unreadable"; reason: string };

/** Whether a workspace has a connection, and when it was made. Never the token. */
export type DriveConnectionMeta = { connected: false } | { connected: true; connectedAt: string };

type VaultRow = { id: string; ciphertext: string; iv: string; tag: string };

async function inTransaction<T>(sql: Sql, fn: (tx: Sql) => Promise<T>): Promise<T> {
  if (!sql.begin) throw new Error("This database connection cannot run a transaction, so nothing was changed.");
  return sql.begin(fn);
}

export async function readDriveConnectionMeta(sql: Sql, organizationId: string): Promise<DriveConnectionMeta> {
  const rows = await sql<{ created_at: unknown }>`
    select created_at from credential_vault
    where organization_id = ${organizationId} and credential_type = ${DRIVE_CREDENTIAL_TYPE}
    limit 1
  `;
  const row = rows[0];
  if (!row) return { connected: false };
  return { connected: true, connectedAt: isoTimestamp(row.created_at) };
}

/** Opens a stored connection. A row that cannot be opened is reported as unreadable, never treated as absent. */
function openRefreshToken(row: VaultRow, masterKey: string): WorkspaceRefreshTokenLookup {
  if (!masterKey.trim()) {
    return { status: "unreadable", reason: "TOKEN_ENCRYPTION_KEY is not configured, so this workspace's stored Drive connection cannot be opened." };
  }
  try {
    const payload = JSON.parse(decryptPayload({ ciphertext: row.ciphertext, iv: row.iv, tag: row.tag }, masterKey.trim())) as {
      refreshToken?: unknown;
    };
    if (typeof payload.refreshToken === "string" && payload.refreshToken.trim()) {
      return { status: "found", refreshToken: payload.refreshToken };
    }
  } catch {
    // Fall through to the fixed message below. The decrypt error can hold no secret, but none of it is needed.
  }
  return {
    status: "unreadable",
    reason: "The stored Drive connection could not be opened. Its key may have changed. Disconnect and connect Drive again.",
  };
}

export async function lookupWorkspaceRefreshToken(sql: Sql, organizationId: string, masterKey: string): Promise<WorkspaceRefreshTokenLookup> {
  const rows = await sql<VaultRow>`
    select id, ciphertext, iv, tag from credential_vault
    where organization_id = ${organizationId} and credential_type = ${DRIVE_CREDENTIAL_TYPE}
    limit 1
  `;
  const row = rows[0];
  if (!row) return { status: "none" };
  return openRefreshToken(row, masterKey);
}

/** Stores the workspace's refresh token, replacing any earlier one, in one transaction. */
export async function saveDriveRefreshToken(
  sql: Sql,
  input: { organizationId: string; refreshToken: string; connectedByUserId: string; masterKey: string },
): Promise<void> {
  const key = input.masterKey.trim();
  if (!key) throw new Error("TOKEN_ENCRYPTION_KEY is not configured. The Drive connection was not stored.");
  if (!input.refreshToken.trim()) throw new Error("Google did not return a refresh token. The Drive connection was not stored.");
  const envelope = encryptPayload(
    JSON.stringify({ refreshToken: input.refreshToken, scope: DRIVE_FILE_SCOPE, connectedBy: input.connectedByUserId }),
    key,
  );
  await inTransaction(sql, async (tx) => {
    await tx`
      delete from credential_vault where organization_id = ${input.organizationId} and credential_type = ${DRIVE_CREDENTIAL_TYPE}
    `;
    await tx`
      insert into credential_vault (id, organization_id, credential_type, ciphertext, iv, tag, key_version)
      values (${`cred_${randomUUID()}`}, ${input.organizationId}, ${DRIVE_CREDENTIAL_TYPE}, ${envelope.ciphertext}, ${envelope.iv}, ${envelope.tag}, ${envelope.keyVersion})
    `;
  });
}

/**
 * Removes the workspace's connection and returns its refresh token, so the caller can revoke it at Google. When the token
 * cannot be opened, the row is still removed and `refreshToken` is null, with the reason.
 */
export async function removeDriveRefreshToken(
  sql: Sql,
  input: { organizationId: string; masterKey: string },
): Promise<{ removed: false } | { removed: true; refreshToken: string | null; reason: string | null }> {
  return inTransaction(sql, async (tx) => {
    const rows = await tx<VaultRow>`
      select id, ciphertext, iv, tag from credential_vault
      where organization_id = ${input.organizationId} and credential_type = ${DRIVE_CREDENTIAL_TYPE}
      limit 1
    `;
    const row = rows[0];
    if (!row) return { removed: false as const };
    const opened = openRefreshToken(row, input.masterKey);
    await tx`
      delete from credential_vault where organization_id = ${input.organizationId} and credential_type = ${DRIVE_CREDENTIAL_TYPE}
    `;
    if (opened.status === "found") return { removed: true as const, refreshToken: opened.refreshToken, reason: null };
    return { removed: true as const, refreshToken: null, reason: opened.status === "unreadable" ? opened.reason : "No token was stored." };
  });
}
