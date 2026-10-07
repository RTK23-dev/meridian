import { randomUUID } from "node:crypto";
import { encryptPayload, decryptPayload } from "./crypto.ts";
import type { Sql } from "../learning/store.ts";

export type StoredCredential = {
  id: string;
  organizationId: string;
  credentialType: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type VaultCredentialPayload = {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresIn?: number;
  apiKey?: string;
  customFields?: Record<string, unknown>;
};

function resolveMasterKey(overrideKey?: string): string {
  const key = overrideKey || process.env.TOKEN_ENCRYPTION_KEY || "";
  if (!key.trim()) {
    throw new Error("TOKEN_ENCRYPTION_KEY is not configured.");
  }
  return key.trim();
}

/**
 * Stores an encrypted credential payload in the vault.
 */
export async function storeVaultCredential(
  sql: Sql,
  organizationId: string,
  credentialType: string,
  payload: VaultCredentialPayload,
  options: { expiresAt?: Date; masterKey?: string } = {},
): Promise<{ id: string }> {
  if (!organizationId.trim()) throw new Error("organizationId is required.");
  if (!credentialType.trim()) throw new Error("credentialType is required.");

  const masterKey = resolveMasterKey(options.masterKey);
  const serialized = JSON.stringify(payload);
  const envelope = encryptPayload(serialized, masterKey);
  const id = `cred_${randomUUID()}`;
  const expiresAtIso = options.expiresAt ? options.expiresAt.toISOString() : null;

  await sql`
    insert into credential_vault (
      id, organization_id, credential_type, ciphertext, iv, tag, key_version, expires_at
    ) values (
      ${id}, ${organizationId}, ${credentialType}, ${envelope.ciphertext}, ${envelope.iv}, ${envelope.tag}, ${envelope.keyVersion}, ${expiresAtIso}
    )
  `;

  return { id };
}

/**
 * Retrieves and decrypts a credential payload from the vault with strict tenant scoping.
 */
export async function retrieveVaultCredential(
  sql: Sql,
  organizationId: string,
  credentialId: string,
  options: { masterKey?: string } = {},
): Promise<VaultCredentialPayload | null> {
  if (!organizationId.trim() || !credentialId.trim()) return null;
  const masterKey = resolveMasterKey(options.masterKey);

  const rows = await sql`
    select id, organization_id, ciphertext, iv, tag, key_version, expires_at
    from credential_vault
    where id = ${credentialId} and organization_id = ${organizationId}
    limit 1
  `;

  if (!rows || rows.length === 0) return null;
  const row = rows[0] as {
    ciphertext: string;
    iv: string;
    tag: string;
    expires_at: string | null;
  };

  try {
    const decrypted = decryptPayload(
      { ciphertext: row.ciphertext, iv: row.iv, tag: row.tag },
      masterKey,
    );
    return JSON.parse(decrypted) as VaultCredentialPayload;
  } catch (err) {
    throw new Error(`Failed to decrypt vault credential: ${err instanceof Error ? err.message : "Authentication error"}`);
  }
}

/**
 * Removes a credential from the vault.
 */
export async function deleteVaultCredential(
  sql: Sql,
  organizationId: string,
  credentialId: string,
): Promise<boolean> {
  if (!organizationId.trim() || !credentialId.trim()) return false;
  await sql`
    delete from credential_vault
    where id = ${credentialId} and organization_id = ${organizationId}
  `;
  return true;
}
