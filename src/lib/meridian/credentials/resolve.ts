/**
 * The one credential resolver. Runtime execution, readiness checks, the settings summary and Test Connection all read a
 * provider key through `resolveCredential`, and no other code reads a provider key from the vault or from the environment.
 * The rules are in docs/ARCHITECTURE_CONTRACTS.md, section 1, in this order:
 *
 *  1. The workspace's own saved entry is used when it is usable. The read is scoped to this organization.
 *  2. A saved entry that cannot be used (expired, unreadable, or without a key) is `unusable`. The deployment key is never
 *     returned in its place, even when the shared default is set.
 *  3. With no saved entry, the deployment key is used only when SHARED_DEFAULT_ENV[category] is set to its accepted value.
 *     Otherwise the result is `not_configured`.
 *
 * The secret is returned only inside a `ready` resolution, for the caller that makes the provider request. Callers that
 * report state use `credentialStateOf`, which carries the masked fingerprint and never the key.
 */
import { ProviderConfigResolver } from "../config/resolver.ts";
import type { Sql } from "../learning/store.ts";
import { retrieveVaultCredential } from "../vault/service.ts";
import {
  CREDENTIAL_VAULT_TYPE,
  SHARED_DEFAULT_ENV,
  credentialFingerprint,
  type CredentialCategory,
  type CredentialResolution,
} from "./contract.ts";

/** The environment a resolution reads. Injected by tests; production passes `process.env`. */
export type CredentialEnv = Record<string, string | undefined>;

/**
 * The shared database handle, loaded only when a call needs it, so importing a provider module starts no database. Used
 * when a provider was not given a connection of its own.
 */
export async function loadDefaultSql(): Promise<Sql> {
  const { getSql } = await import("../../db.ts");
  return getSql();
}

/** Short names used in the reasons shown to a reviewer. They contain no secret. */
const CATEGORY_LABEL: Record<CredentialCategory, string> = {
  perception: "Gemini",
  jev: "TypeSafe JEV",
  production: "Gemini",
};

/**
 * The deployment's own key for a category. It is read here, and it is used only when the category's shared default is
 * opted in. The Google key follows the documented aliases in config/resolver.ts. The TypeSafe key follows the canonical and
 * legacy names used by jev/config.ts.
 */
function deploymentKeyFor(category: CredentialCategory, env: CredentialEnv): string {
  if (category === "jev") {
    return env.TYPESAFE_JEV_API_KEY?.trim() || env.TYPESAFE_API_KEY?.trim() || "";
  }
  return ProviderConfigResolver.resolveGoogle({ env }).apiKey?.trim() ?? "";
}

/** The expiry as milliseconds, null when the entry does not expire, or "invalid" when the stored value cannot be read. */
function expiryMillis(value: unknown): number | null | "invalid" {
  if (value === null || value === undefined || value === "") return null;
  const time = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return Number.isFinite(time) ? time : "invalid";
}

async function resolveSavedEntry(
  sql: Sql,
  organizationId: string,
  category: CredentialCategory,
  row: { id: string; expires_at: unknown },
): Promise<CredentialResolution> {
  const label = CATEGORY_LABEL[category];
  const unusable = (reason: string): CredentialResolution => ({ status: "unusable", source: "workspace", reason });

  const expiry = expiryMillis(row.expires_at);
  if (expiry === "invalid") {
    return unusable(`The workspace's saved ${label} credential has an expiry that cannot be read. Save the key again in the settings.`);
  }
  if (expiry !== null && expiry <= Date.now()) {
    return unusable(`The workspace's saved ${label} credential has expired. Save a new key in the settings.`);
  }

  let payload: Awaited<ReturnType<typeof retrieveVaultCredential>>;
  try {
    payload = await retrieveVaultCredential(sql, organizationId, row.id);
  } catch {
    return unusable(`The workspace's saved ${label} credential could not be read. Save the key again in the settings.`);
  }
  const apiKey = payload?.apiKey?.trim() ?? "";
  if (!apiKey) {
    return unusable(`The workspace has a saved ${label} entry, but it holds no key. Save a key in the settings.`);
  }
  return { status: "ready", source: "workspace", secret: apiKey, fingerprint: credentialFingerprint(apiKey) ?? "" };
}

/**
 * Whether the deployment's key is a shared default for a category (SHARED_DEFAULT_ENV). Every transport that uses a
 * deployment key for a category reads this same flag.
 */
export function sharedDefaultOptedIn(category: CredentialCategory, env: CredentialEnv = process.env): boolean {
  const rule = SHARED_DEFAULT_ENV[category];
  return (env[rule.variable] ?? "").trim().toLowerCase() === rule.accepts;
}

function resolveSharedDefault(category: CredentialCategory, env: CredentialEnv): CredentialResolution {
  const label = CATEGORY_LABEL[category];
  const rule = SHARED_DEFAULT_ENV[category];
  if (!sharedDefaultOptedIn(category, env)) {
    return {
      status: "not_configured",
      reason: `This workspace has no saved ${label} credential, and the deployment does not share one. Set ${rule.variable}=${rule.accepts} to use the deployment key.`,
    };
  }
  const key = deploymentKeyFor(category, env);
  if (!key) {
    return { status: "not_configured", reason: `${rule.variable}=${rule.accepts}, but the deployment has no ${label} key set.` };
  }
  return { status: "ready", source: "deployment_shared_default", secret: key, fingerprint: credentialFingerprint(key) ?? "" };
}

/**
 * Resolves the credential a category uses for one workspace. It throws only when the database cannot be read. Callers that
 * make a provider request treat a throw as "no call". Callers that report state treat it as "could not be checked".
 */
export async function resolveCredential(
  sql: Sql,
  organizationId: string,
  category: CredentialCategory,
  env: CredentialEnv = process.env,
): Promise<CredentialResolution> {
  const scope = organizationId?.trim() ?? "";
  if (!scope) {
    return {
      status: "not_configured",
      reason: `No workspace is in scope, so no ${CATEGORY_LABEL[category]} credential can be used.`,
    };
  }

  const rows = await sql<{ id: string; expires_at: unknown }>`
    select id, expires_at from credential_vault
    where organization_id = ${scope} and credential_type = ${CREDENTIAL_VAULT_TYPE[category]}
    limit 1
  `;
  const row = rows[0];
  if (row) return resolveSavedEntry(sql, scope, category, row);
  return resolveSharedDefault(category, env);
}

/**
 * Higgsfield's key is the deployment's own. It is a production key, so it is used only when PRODUCTION_SHARED_DEFAULT=deployment
 * is set. It is never used in place of an unusable saved production entry for the workspace, and it is never used for a
 * workspace that has no opt-in. Every other production check follows the same rules through resolveCredential.
 */
export async function resolveHiggsfieldCredential(
  sql: Sql,
  organizationId: string,
  env: CredentialEnv = process.env,
): Promise<CredentialResolution> {
  const saved = await resolveCredential(sql, organizationId, "production", env);
  if (saved.status === "unusable") {
    return {
      status: "unusable",
      source: "workspace",
      reason: `${saved.reason} Higgsfield does not use the deployment key in its place.`,
    };
  }
  if (!sharedDefaultOptedIn("production", env)) {
    return {
      status: "not_configured",
      reason: "Higgsfield uses the deployment's HIGGSFIELD_API_KEY only when PRODUCTION_SHARED_DEFAULT=deployment is set.",
    };
  }
  const key = (env.HIGGSFIELD_API_KEY ?? "").trim();
  if (!key) return { status: "not_configured", reason: "PRODUCTION_SHARED_DEFAULT=deployment, but HIGGSFIELD_API_KEY is not set on the deployment." };
  return { status: "ready", source: "deployment_shared_default", secret: key, fingerprint: credentialFingerprint(key) ?? "" };
}
