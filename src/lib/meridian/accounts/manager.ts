import { randomUUID } from "node:crypto";
import type { Sql } from "../learning/store.ts";
import { storeVaultCredential, retrieveVaultCredential, type VaultCredentialPayload } from "../vault/service.ts";
function asRecord(value: unknown): Record<string, string> {
  let source: unknown = value;
  if (typeof value === "string") {
    try {
      source = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(source)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

export type PlatformAccount = {
  id: string;
  organizationId: string;
  brandId: string;
  platform: string;
  accountType: string;
  externalAccountId: string;
  name: string;
  handle: string;
  avatarUrl: string;
  credentialId: string | null;
  status: "connected" | "disconnected" | "expired" | "invalid_permissions";
  metadata: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

export type ConnectAccountInput = {
  platform: string;
  accountType?: string;
  externalAccountId: string;
  name: string;
  handle?: string;
  avatarUrl?: string;
  credentials?: VaultCredentialPayload;
  metadata?: Record<string, string>;
  expiresAt?: Date;
};

/**
 * Lists all connected platform accounts for a brand.
 */
export async function listBrandPlatformAccounts(
  sql: Sql,
  organizationId: string,
  brandId: string,
  platformFilter?: string,
): Promise<PlatformAccount[]> {
  const rows = platformFilter
    ? await sql`
        select id, organization_id, brand_id, platform, account_type, external_account_id,
               name, handle, avatar_url, credential_id, status, metadata, created_at, updated_at
        from platform_accounts
        where organization_id = ${organizationId} and brand_id = ${brandId} and platform = ${platformFilter}
        order by created_at desc
      `
    : await sql`
        select id, organization_id, brand_id, platform, account_type, external_account_id,
               name, handle, avatar_url, credential_id, status, metadata, created_at, updated_at
        from platform_accounts
        where organization_id = ${organizationId} and brand_id = ${brandId}
        order by platform asc, created_at desc
      `;
  return (rows || []).map((r: any) => ({
    id: r.id,
    organizationId: r.organization_id,
    brandId: r.brand_id,
    platform: r.platform,
    accountType: r.account_type,
    externalAccountId: r.external_account_id,
    name: r.name,
    handle: r.handle || "",
    avatarUrl: r.avatar_url || "",
    credentialId: r.credential_id || null,
    status: r.status,
    metadata: asRecord(r.metadata),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

/**
 * Connects or updates a platform account for a brand, optionally storing encrypted credentials in the vault.
 */
export async function connectPlatformAccount(
  sql: Sql,
  organizationId: string,
  brandId: string,
  input: ConnectAccountInput,
): Promise<{ accountId: string; credentialId: string | null }> {
  if (!organizationId.trim() || !brandId.trim()) throw new Error("Tenancy context required.");
  if (!input.platform.trim() || !input.externalAccountId.trim() || !input.name.trim()) {
    throw new Error("Platform, external account ID, and account name are required.");
  }

  let credentialId: string | null = null;
  if (input.credentials) {
    const cred = await storeVaultCredential(
      sql,
      organizationId,
      `${input.platform}_oauth`,
      input.credentials,
      { expiresAt: input.expiresAt },
    );
    credentialId = cred.id;
  }

  const accountId = `acc_${randomUUID()}`;
  const metadataJson = JSON.stringify(input.metadata || {});

  await sql`
    insert into platform_accounts (
      id, organization_id, brand_id, platform, account_type, external_account_id,
      name, handle, avatar_url, credential_id, status, metadata
    ) values (
      ${accountId}, ${organizationId}, ${brandId}, ${input.platform},
      ${input.accountType || "social_page"}, ${input.externalAccountId},
      ${input.name}, ${input.handle || ""}, ${input.avatarUrl || ""},
      ${credentialId}, 'connected', ${metadataJson}::jsonb
    )
    on conflict (organization_id, brand_id, platform, external_account_id)
    do update set
      name = excluded.name,
      handle = excluded.handle,
      avatar_url = excluded.avatar_url,
      credential_id = coalesce(excluded.credential_id, platform_accounts.credential_id),
      status = 'connected',
      metadata = excluded.metadata,
      updated_at = now()
  `;

  return { accountId, credentialId };
}

/**
 * Disconnects a platform account and marks its status as disconnected.
 */
export async function disconnectPlatformAccount(
  sql: Sql,
  organizationId: string,
  brandId: string,
  accountId: string,
): Promise<boolean> {
  await sql`
    update platform_accounts
    set status = 'disconnected', updated_at = now()
    where id = ${accountId} and organization_id = ${organizationId} and brand_id = ${brandId}
  `;
  return true;
}

/**
 * Resolves credentials for a connected platform account.
 */
export async function getAccountDecryptedCredential(
  sql: Sql,
  organizationId: string,
  brandId: string,
  accountId: string,
): Promise<VaultCredentialPayload | null> {
  const rows = await sql<{ credential_id: string | null }>`
    select credential_id from platform_accounts
    where id = ${accountId} and organization_id = ${organizationId} and brand_id = ${brandId}
    limit 1
  `;
  const row = rows[0];
  if (!row || !row.credential_id) return null;
  return retrieveVaultCredential(sql, organizationId, row.credential_id);
}
