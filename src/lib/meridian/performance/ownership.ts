import type { Sql } from "../learning/store.ts";
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
  const credentials = await sql<{ sealed_token: string }>`
    select sealed_token from provider_secrets
    where organization_id = ${organizationId} and provider = 'meta' limit 1
  `;
  const sealed = credentials[0]?.sealed_token ?? "";
  if (!sealed.trim()) return { status: "NOT_CONNECTED", error: "Meta performance sync has no tenant-scoped OAuth credential. No observations were stored." };
  if (!encryptionKey.trim()) return { status: "NOT_CONNECTED", error: "TOKEN_ENCRYPTION_KEY is not configured. No observations were stored." };
  try {
    const opened = openSecret(sealed, encryptionKey);
    if (typeof opened !== "string" || !opened.trim()) {
      return { status: "NOT_CONNECTED", error: typeof opened === "string" ? "The tenant Meta credential is empty. No observations were stored." : `${opened.error} No observations were stored.` };
    }
    return { status: "connected", accessToken: opened };
  } catch {
    return { status: "NOT_CONNECTED", error: "The tenant Meta credential could not be opened. No observations were stored." };
  }
}
