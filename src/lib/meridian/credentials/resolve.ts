/**
 * The one resolver for JEV and production provider keys (docs/ARCHITECTURE_CONTRACTS.md, section 1). Runtime execution,
 * the readiness check, the settings summary and Test Connection all call it, so they cannot disagree.
 *
 * Order, for one organization:
 *  1. The workspace's saved entry for the category, read only for this organization. If it is saved but cannot be used
 *     (expired, unreadable, without a key, or too short to be a key), the result is unusable. The deployment key is never
 *     put in its place.
 *  2. With no saved entry, the deployment key only when the operator set SHARED_DEFAULT_ENV for the category.
 *  3. Otherwise, not configured.
 *
 * The secret goes only to the caller that makes the provider request. Everything else carries the masked fingerprint.
 * Perception keeps its own resolver (perception/credential.ts) and is not handled here.
 */
import type { Sql } from "../learning/store.ts";
import { retrieveVaultCredential } from "../vault/service.ts";
import {
  CREDENTIAL_VAULT_TYPE,
  SHARED_DEFAULT_ENV,
  credentialFingerprint,
  type CredentialCategory,
  type CredentialResolution,
} from "./contract.ts";

/** The categories this resolver serves. */
export type ResolvedCategory = Extract<CredentialCategory, "jev" | "production">;

/** Deployment variables that hold each category's key, in precedence order. */
const DEPLOYMENT_KEY_VARS: Record<ResolvedCategory, readonly string[]> = {
  jev: ["TYPESAFE_JEV_API_KEY", "TYPESAFE_API_KEY"],
  production: ["MERIDIAN_GEMINI_API_KEY", "GOOGLE_AI_STUDIO_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

type Env = Record<string, string | undefined>;

/** The deployment's key for a category, ignoring the shared-default opt-in. Used by the TypeSafe JEV and Gemini paths. */
export function deploymentKeyFor(category: ResolvedCategory, env: Env = process.env): string | undefined {
  for (const variable of DEPLOYMENT_KEY_VARS[category]) {
    const value = env[variable]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** True when the operator opted this category into the deployment key as a shared default. */
export function sharesDeploymentKey(category: ResolvedCategory, env: Env = process.env): boolean {
  const { variable, accepts } = SHARED_DEFAULT_ENV[category];
  return (env[variable] ?? "").trim().toLowerCase() === accepts;
}

/**
 * Resolves the key a category's runtime may use for one organization. `sql` is the caller's connection; without one the
 * workspace entry cannot be read, so the result is not configured rather than a guess.
 */
export async function resolveCredential(
  sql: Sql | undefined,
  organizationId: string,
  category: ResolvedCategory,
  env: Env = process.env,
): Promise<CredentialResolution> {
  if (!organizationId.trim()) {
    return { status: "not_configured", reason: "No organization was given, so no workspace key can be read." };
  }
  if (!sql) {
    return { status: "not_configured", reason: "No database connection is available, so this workspace's saved key cannot be read." };
  }

  const rows = await sql<{ id: string; expires_at: unknown }>`
    select id, expires_at from credential_vault
    where organization_id = ${organizationId} and credential_type = ${CREDENTIAL_VAULT_TYPE[category]}
    limit 1
  `;
  const row = rows[0];
  if (row) {
    const unusable = (reason: string): CredentialResolution => ({ status: "unusable", source: "workspace", reason });
    if (row.expires_at && new Date(String(row.expires_at)).getTime() <= Date.now()) {
      return unusable("The workspace's saved key has expired. Save a new key in the settings.");
    }
    let payload: Awaited<ReturnType<typeof retrieveVaultCredential>>;
    try {
      payload = await retrieveVaultCredential(sql, organizationId, row.id);
    } catch {
      return unusable("The workspace's saved key could not be read. Save the key again in the settings.");
    }
    const secret = payload?.apiKey?.trim() ?? "";
    if (!secret) return unusable("The workspace has a saved entry, but it holds no key. Save a key in the settings.");
    const fingerprint = credentialFingerprint(secret);
    if (!fingerprint) return unusable("The workspace's saved key is too short to be a real key. Save it again in the settings.");
    return { status: "ready", source: "workspace", secret, fingerprint };
  }

  if (!sharesDeploymentKey(category, env)) {
    return {
      status: "not_configured",
      reason: `This workspace has no saved key, and the deployment does not share one for ${category}. Set ${SHARED_DEFAULT_ENV[category].variable}=${SHARED_DEFAULT_ENV[category].accepts} to share it.`,
    };
  }
  const secret = deploymentKeyFor(category, env);
  if (!secret) {
    return {
      status: "not_configured",
      reason: `${SHARED_DEFAULT_ENV[category].variable}=${SHARED_DEFAULT_ENV[category].accepts}, but the deployment has no ${category} key set.`,
    };
  }
  const fingerprint = credentialFingerprint(secret);
  if (!fingerprint) {
    return { status: "not_configured", reason: `The deployment's ${category} key is too short to be a real key.` };
  }
  return { status: "ready", source: "deployment_shared_default", secret, fingerprint };
}
