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
