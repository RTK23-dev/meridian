import type { CredentialCategory } from "../credentials/contract.ts";
import { resolveCredential, type CredentialEnv } from "../credentials/resolve.ts";
import type { Sql } from "../learning/store.ts";
import { openAccessToken } from "./stages.ts";

/**
 * The workspace's saved key that stands in for a missing OAuth token, by provider. Google has no saved-key category, so a Google
 * account is used only with its OAuth token.
 */
const SAVED_KEY_CATEGORY: Partial<Record<string, CredentialCategory>> = {
  meta: "meta_graph",
  tiktok: "tiktok",
  ad_library: "meta_ad_library",
};

export type AccessTokenResolution =
  | { token: string; source: "sealed" | "workspace" | "deployment_shared_default" }
  | { error: string };

/**
 * The token a provider request uses for one workspace. A sealed OAuth token from `provider_secrets` wins, and a sealed row that
 * cannot be opened is an error with no fallback. With no sealed token, the workspace's saved key is used. The deployment's own
 * key is used only when its shared-default variable is set, which is the resolver's rule. Environment tokens are not read.
 */
export async function providerAccessToken(
  sql: Sql,
  input: { organizationId: string; provider: string; sealed: string; encryptionKey: string; env?: CredentialEnv },
): Promise<AccessTokenResolution> {
  if (input.sealed.trim()) {
    const opened = openAccessToken({ sealed: input.sealed, key: input.encryptionKey });
    if ("error" in opened) return opened;
    return { token: opened.token, source: "sealed" };
  }
  const category = SAVED_KEY_CATEGORY[input.provider];
  if (!category) return { error: "No access token is stored for this workspace. Nothing was sent." };
  try {
    const resolution = await resolveCredential(sql, input.organizationId, category, input.env ?? process.env);
    if (resolution.status === "ready") return { token: resolution.secret, source: resolution.source };
    return { error: resolution.reason };
  } catch {
    return { error: "The saved credential could not be checked. Nothing was sent." };
  }
}

/** The state of a provider's credential for one workspace. It never carries a token. */
export type ProviderCredentialState = { state: "usable" | "unusable" | "not_configured"; reason: string };

const NO_CREDENTIAL_REASON = "No access token is stored and none is configured. Nothing was sent.";
const UNCHECKED_REASON = "The stored credential could not be checked. Nothing was sent.";

/**
 * The state of a provider's credential for one workspace, decided by the precedence providerAccessToken uses, with no token in
 * the result. A sealed token that opens is usable, and one that does not is unusable, with no fallback to the saved key. With no
 * sealed token, the saved key's state comes from resolveCredential. An opened token is dropped here. A thrown error is unusable
 * with a fixed message, and nothing from the error is returned.
 */
/**
 * The providers whose performance is read per tenant: their metric sync checks the ownership of each account with the workspace's own OAuth
 * token (performance/ownership.ts). A saved key is not enough for them, so the status must say so too (review 2026-10-22, item 5).
 */
export const OAUTH_METRIC_PROVIDERS: readonly string[] = ["meta", "tiktok", "google"];

export async function providerCredentialState(
  sql: Sql,
  input: { organizationId: string; provider: string; sealed: string; encryptionKey: string; env?: CredentialEnv; requireOAuth?: boolean },
): Promise<ProviderCredentialState> {
  try {
    if (input.requireOAuth === true && !input.sealed.trim()) {
      return { state: "unusable", reason: "Metric sync needs the workspace's OAuth connection; a saved key is not enough, so nothing was read." };
    }
    if (input.sealed.trim()) {
      const opened = openAccessToken({ sealed: input.sealed, key: input.encryptionKey });
      if ("error" in opened) return { state: "unusable", reason: opened.error };
      return { state: "usable", reason: "The stored access token can be opened." };
    }
    const category = SAVED_KEY_CATEGORY[input.provider];
    if (!category) return { state: "not_configured", reason: NO_CREDENTIAL_REASON };
    const resolution = await resolveCredential(sql, input.organizationId, category, input.env ?? process.env);
    if (resolution.status === "ready") {
      return resolution.source === "workspace"
        ? { state: "usable", reason: "The workspace's saved credential can be used." }
        : { state: "usable", reason: "The deployment's shared credential can be used for this workspace." };
    }
    if (resolution.status === "unusable") return { state: "unusable", reason: resolution.reason };
    return { state: "not_configured", reason: resolution.reason };
  } catch {
    return { state: "unusable", reason: UNCHECKED_REASON };
  }
}
