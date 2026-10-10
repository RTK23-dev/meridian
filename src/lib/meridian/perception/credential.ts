/**
 * The one place a perception credential is resolved. Production perception calls and the settings panel both use it, so
 * the panel can never report perception as configured with a credential the provider would not use.
 *
 * Order:
 *  1. The workspace's own saved credential (the encrypted vault entry for the perception category, read only for this
 *     organization). If one is saved but cannot be used (expired, unreadable, or without a key), that is reported as
 *     unusable. It is never silently replaced by the deployment key.
 *  2. The deployment's Gemini key, only when the operator set PERCEPTION_SHARED_DEFAULT=gemini. It is an intentional shared
 *     default, not an accident of the environment.
 *  3. Otherwise, not configured.
 *
 * The key is returned to the caller that makes the request, and nowhere else. Callers show the masked fingerprint only.
 */
import { ProviderConfigResolver } from "../config/resolver.ts";
import type { Sql } from "../learning/store.ts";
import { retrieveVaultCredential } from "../vault/service.ts";

/** The vault entry the settings panel writes for the perception category (see settings/provider-config.ts). */
export const PERCEPTION_CREDENTIAL_TYPE = "provider_config:perception";
export const PERCEPTION_SHARED_DEFAULT_ENV = "PERCEPTION_SHARED_DEFAULT";

export type PerceptionCredential =
  | { status: "ready"; source: "workspace" | "deployment_shared_default"; apiKey: string; fingerprint: string }
  | { status: "not_configured"; reason: string }
  | { status: "unusable"; source: "workspace"; reason: string };

export function fingerprintOf(apiKey: string): string {
  return apiKey.length >= 4 ? `...${apiKey.slice(-4)}` : "...";
}

export async function resolvePerceptionCredential(
  sql: Sql,
  organizationId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<PerceptionCredential> {
  const rows = await sql<{ id: string; expires_at: unknown }>`
    select id, expires_at from credential_vault
    where organization_id = ${organizationId} and credential_type = ${PERCEPTION_CREDENTIAL_TYPE}
    limit 1
  `;
  const row = rows[0];
  if (row) {
    const unusable = (reason: string): PerceptionCredential => ({ status: "unusable", source: "workspace", reason });
    if (row.expires_at && new Date(String(row.expires_at)).getTime() <= Date.now()) {
      return unusable("The workspace's saved Gemini credential has expired. Save a new key in the settings.");
    }
    let payload: Awaited<ReturnType<typeof retrieveVaultCredential>>;
    try {
      payload = await retrieveVaultCredential(sql, organizationId, row.id);
    } catch {
      return unusable("The workspace's saved Gemini credential could not be read. Save the key again in the settings.");
    }
    const apiKey = payload?.apiKey?.trim() ?? "";
    if (!apiKey) return unusable("The workspace has a perception entry, but it holds no Gemini API key. Save a key in the settings.");
    return { status: "ready", source: "workspace", apiKey, fingerprint: fingerprintOf(apiKey) };
  }

  if ((env[PERCEPTION_SHARED_DEFAULT_ENV] ?? "").trim().toLowerCase() === "gemini") {
    const apiKey = ProviderConfigResolver.resolveGoogle({ env }).apiKey?.trim() ?? "";
    if (apiKey) return { status: "ready", source: "deployment_shared_default", apiKey, fingerprint: fingerprintOf(apiKey) };
    return { status: "not_configured", reason: `${PERCEPTION_SHARED_DEFAULT_ENV}=gemini, but the deployment has no Gemini key set.` };
  }

  return {
    status: "not_configured",
    reason: "This workspace has no saved Gemini credential, and the deployment does not share one for perception.",
  };
}
