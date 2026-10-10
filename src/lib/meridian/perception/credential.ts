/**
 * The perception credential, as perception calls see it. It is a thin wrapper over the shared resolver in
 * credentials/resolve.ts, so perception and every other category follow the same rules. The rules are in
 * docs/ARCHITECTURE_CONTRACTS.md, section 1.
 *
 *  - A saved workspace key is used first, and only for that workspace.
 *  - A saved key that cannot be used is reported as unusable. The deployment key is never used in its place.
 *  - The deployment's Gemini key is used only when PERCEPTION_SHARED_DEFAULT=gemini is set.
 *
 * The key is returned to the caller that makes the request, and nowhere else. Callers show the masked fingerprint only.
 */
import type { Sql } from "../learning/store.ts";
import { resolveCredential, type CredentialEnv } from "../credentials/resolve.ts";
import { CREDENTIAL_VAULT_TYPE, SHARED_DEFAULT_ENV } from "../credentials/contract.ts";

/** The vault entry the settings panel writes for the perception category. */
export const PERCEPTION_CREDENTIAL_TYPE = CREDENTIAL_VAULT_TYPE.perception;
export const PERCEPTION_SHARED_DEFAULT_ENV = SHARED_DEFAULT_ENV.perception.variable;

export type PerceptionCredential =
  | { status: "ready"; source: "workspace" | "deployment_shared_default"; apiKey: string; fingerprint: string }
  | { status: "not_configured"; reason: string }
  | { status: "unusable"; source: "workspace"; reason: string };

/** Shows the last four characters only when at least half of the key stays hidden. */
export function fingerprintOf(apiKey: string): string {
  return apiKey.length >= 8 ? `...${apiKey.slice(-4)}` : "...";
}

export async function resolvePerceptionCredential(
  sql: Sql,
  organizationId: string,
  env: CredentialEnv = process.env,
): Promise<PerceptionCredential> {
  const resolution = await resolveCredential(sql, organizationId, "perception", env);
  if (resolution.status === "ready") {
    return { status: "ready", source: resolution.source, apiKey: resolution.secret, fingerprint: fingerprintOf(resolution.secret) };
  }
  return resolution;
}
