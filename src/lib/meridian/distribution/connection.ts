import type { Sql } from "../learning/store.ts";
import type { VaultCredentialPayload } from "../vault/service.ts";
import { retrieveVaultCredential } from "../vault/service.ts";
import type { OrganicConnection, OrganicPlatform } from "./types.ts";

/** The Google scope a YouTube Shorts upload needs. */
export const YOUTUBE_UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";

/** The TikTok scope the Content Posting API needs to upload a video. */
export const TIKTOK_POSTING_SCOPE = "video.publish";

export const ORGANIC_PLATFORMS: readonly OrganicPlatform[] = ["instagram", "facebook", "youtube", "tiktok"];

export function isOrganicPlatform(value: string): value is OrganicPlatform {
  return (ORGANIC_PLATFORMS as readonly string[]).includes(value);
}

const LABEL: Record<OrganicPlatform, string> = {
  instagram: "Instagram",
  facebook: "Facebook Page",
  youtube: "YouTube",
  tiktok: "TikTok",
};

const ACCOUNT_ID_LABEL: Record<OrganicPlatform, string> = {
  instagram: "Instagram account ID",
  facebook: "Page ID",
  youtube: "channel ID",
  tiktok: "TikTok account ID",
};

function notConnected(platform: OrganicPlatform, reason: string): OrganicConnection {
  return { connected: false, platform, reason };
}

function parseScopes(value: unknown): string[] | null {
  if (typeof value === "string") {
    const parts = value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
    return parts.length > 0 ? parts : null;
  }
  if (Array.isArray(value)) {
    const parts = value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
    return parts.length > 0 ? parts : null;
  }
  return null;
}

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return recordOf(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Resolves the connected account a brand publishes an organic platform from. The account is a `platform_accounts` row in this
 * workspace and brand with status connected. Its token is the encrypted `credential_vault` entry it points to. No environment
 * variable is read here. Every missing piece returns not connected with the reason, so nothing is sent without a stored token.
 */
export async function resolveOrganicConnection(
  sql: Sql,
  input: { organizationId: string; brandId: string; platform: OrganicPlatform },
  now: Date = new Date(),
): Promise<OrganicConnection> {
  const label = LABEL[input.platform];
  const accounts = await sql<{ external_account_id: string; name: string; credential_id: string | null; metadata: unknown }>`
    select external_account_id, name, credential_id, metadata from platform_accounts
    where organization_id = ${input.organizationId} and brand_id = ${input.brandId}
      and platform = ${input.platform} and status = 'connected'
    order by updated_at desc
    limit 1
  `;
  const account = accounts[0];
  if (!account || !account.external_account_id?.trim()) {
    return notConnected(input.platform, `No ${label} account is connected for this brand. Add its ${ACCOUNT_ID_LABEL[input.platform]} and an access token in Accounts.`);
  }
  if (!account.credential_id) {
    return notConnected(input.platform, `The ${label} account has no stored access token. Save a token for it in Accounts.`);
  }

  const vault = await sql<{ expires_at: unknown }>`
    select expires_at from credential_vault
    where id = ${account.credential_id} and organization_id = ${input.organizationId}
    limit 1
  `;
  if (!vault[0]) {
    return notConnected(input.platform, `The ${label} token is no longer in the vault. Save the token again in Accounts.`);
  }
  if (vault[0].expires_at) {
    const expiresAt = new Date(String(vault[0].expires_at)).getTime();
    if (Number.isFinite(expiresAt) && expiresAt <= now.getTime()) {
      return notConnected(input.platform, `The stored ${label} token has expired. Save a new token in Accounts.`);
    }
  }

  let payload: VaultCredentialPayload | null;
  try {
    payload = await retrieveVaultCredential(sql, input.organizationId, account.credential_id);
  } catch {
    return notConnected(input.platform, `The stored ${label} token could not be opened. Check TOKEN_ENCRYPTION_KEY, then save the token again in Accounts.`);
  }
  const accessToken = payload?.accessToken?.trim() ?? "";
  if (!accessToken) {
    return notConnected(input.platform, `The stored ${label} token is empty. Save a token for it in Accounts.`);
  }

  const scopes = parseScopes(payload?.customFields?.scopes) ?? parseScopes(recordOf(account.metadata).scopes);
  if (input.platform === "youtube" && scopes && !scopes.includes(YOUTUBE_UPLOAD_SCOPE)) {
    return notConnected(input.platform, `The saved YouTube token does not include the upload scope (${YOUTUBE_UPLOAD_SCOPE}). Save a token that grants it.`);
  }
  if (input.platform === "tiktok" && scopes && !scopes.includes(TIKTOK_POSTING_SCOPE)) {
    return notConnected(input.platform, `The saved TikTok token does not include the posting scope (${TIKTOK_POSTING_SCOPE}). Save a token that grants it.`);
  }

  return {
    connected: true,
    platform: input.platform,
    accountId: account.external_account_id.trim(),
    accountName: account.name || account.external_account_id.trim(),
    accessToken,
    scopes,
  };
}

/** Every organic platform's connection state for one brand, resolved one at a time. */
export async function resolveOrganicConnections(
  sql: Sql,
  input: { organizationId: string; brandId: string },
): Promise<Record<OrganicPlatform, OrganicConnection>> {
  const result = {} as Record<OrganicPlatform, OrganicConnection>;
  for (const platform of ORGANIC_PLATFORMS) {
    result[platform] = await resolveOrganicConnection(sql, { ...input, platform });
  }
  return result;
}
