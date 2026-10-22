import type { Sql } from "../learning/store.ts";
import { expiredReason } from "../providers/access-token.ts";
import { openSecret } from "../oauth/flow.server.ts";

export type PerformanceOwnershipInput = {
  organizationId: string;
  brandId: string;
  creativeId: string;
  externalAdId: string;
  provider: string;
};

export async function validatePerformanceOwnership(
  sql: Sql,
  input: PerformanceOwnershipInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const creatives = await sql<{ id: string; organization_id: string; brand_id: string }>`
    select id, organization_id, brand_id from creative_records
    where id = ${input.creativeId} and organization_id = ${input.organizationId} and brand_id = ${input.brandId}
    limit 1
  `;
  if (!creatives.some((row) => row.organization_id === input.organizationId && row.brand_id === input.brandId)) {
    return { ok: false, error: "The selected creative does not belong to this workspace and brand." };
  }
  const ads = await sql<{ external_id: string; organization_id: string; brand_id: string }>`
    select external_id, organization_id, brand_id from provider_objects
    where organization_id = ${input.organizationId} and brand_id = ${input.brandId}
      and provider = ${input.provider} and object_type = 'ad' and status = 'stored' and external_id = ${input.externalAdId}
    limit 1
  `;
  if (!ads.some((row) => row.external_id === input.externalAdId && row.organization_id === input.organizationId && row.brand_id === input.brandId)) {
    return { ok: false, error: "The selected provider ad does not belong to this workspace and brand." };
  }
  return { ok: true };
}

export async function loadTenantMetaToken(
  sql: Sql,
  organizationId: string,
  encryptionKey: string,
): Promise<{ status: "connected"; accessToken: string } | { status: "NOT_CONNECTED"; error: string }> {
  return loadTenantProviderToken(sql, organizationId, "meta", encryptionKey);
}

const PROVIDER_LABEL: Record<"meta" | "tiktok" | "google", string> = { meta: "Meta", tiktok: "TikTok", google: "Google Ads" };

/**
 * The workspace's own sealed OAuth token for one provider, opened with the deployment key. It is the only token a metric read
 * uses. An environment token is never a fallback: with no sealed token the read is not connected and nothing is requested.
 */
export async function loadTenantProviderToken(
  sql: Sql,
  organizationId: string,
  provider: "meta" | "tiktok" | "google",
  encryptionKey: string,
): Promise<{ status: "connected"; accessToken: string } | { status: "NOT_CONNECTED"; error: string }> {
  const label = PROVIDER_LABEL[provider];
  const credentials = await sql<{ sealed_token: string; sealed_refresh: string; expires_at: string | null }>`
    select sealed_token, sealed_refresh, expires_at from provider_secrets
    where organization_id = ${organizationId} and provider = ${provider} limit 1
  `;
  const sealed = credentials[0]?.sealed_token ?? "";
  if (!sealed.trim()) return { status: "NOT_CONNECTED", error: `${label} performance sync has no tenant-scoped OAuth credential. No observations were stored.` };
  if (!encryptionKey.trim()) return { status: "NOT_CONNECTED", error: "TOKEN_ENCRYPTION_KEY is not configured. No observations were stored." };
  try {
    const opened = openSecret(sealed, encryptionKey);
    if (typeof opened !== "string" || !opened.trim()) {
      return { status: "NOT_CONNECTED", error: typeof opened === "string" ? `The tenant ${label} credential is empty. No observations were stored.` : `${opened.error} No observations were stored.` };
    }
    // A token past its stated expiry is not requested (review 2026-10-22, item 6). Nothing renews it on use, so the reason says what to do.
    const expired = expiredReason({
      expiresAt: credentials[0]?.expires_at ? new Date(credentials[0].expires_at).toISOString() : null,
      hasRefresh: (credentials[0]?.sealed_refresh ?? "").trim() !== "",
    });
    if (expired) return { status: "NOT_CONNECTED", error: `${expired} No observations were stored.` };
    return { status: "connected", accessToken: opened };
  } catch {
    return { status: "NOT_CONNECTED", error: `The tenant ${label} credential could not be opened. No observations were stored.` };
  }
}
