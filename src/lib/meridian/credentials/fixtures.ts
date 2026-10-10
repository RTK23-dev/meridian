/**
 * Lookups for tests. A lookup returns a fixed resolution, so a unit test can check a provider's request without a database.
 * The acceptance tests in credentials/ use the real resolver against the database instead.
 */
import { credentialFingerprint, type CredentialResolution } from "./contract.ts";

/** Every workspace gets the same usable saved key. */
export function fixedLookup(secret: string): (organizationId: string) => Promise<CredentialResolution> {
  return async () => ({
    status: "ready",
    source: "workspace",
    secret,
    fingerprint: credentialFingerprint(secret) ?? "",
  });
}

/** Every workspace is not configured, so no request is made. */
export function notConfiguredLookup(reason = "No test key is configured."): (organizationId: string) => Promise<CredentialResolution> {
  return async () => ({ status: "not_configured", reason });
}
