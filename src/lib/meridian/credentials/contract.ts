/**
 * The frozen credential contract. Runtime execution, readiness checks, the settings panel and Test Connection all read a
 * credential through this shape. The one resolver that produces it is `credentials/resolve.ts`, and no other code reads
 * a provider key from the vault or from the environment. The rules are in docs/ARCHITECTURE_CONTRACTS.md, section 1.
 */

/**
 * The provider categories that hold a saved key. Each one resolves its workspace's own entry first, and the deployment's key
 * only when its shared-default variable is opted in. `openai` is the OpenAI Decisions engine. `hypit` is the Hypit
 * production runtime.
 */
export type CredentialCategory = "perception" | "jev" | "production" | "openai" | "hypit" | SourceCredentialCategory;

/**
 * The source connectors that hold a saved key. Each is its own vault entry, so a workspace connects one source without
 * another. A deployment's key (the variables in SOURCE_KEY_ENV, the first one set wins) is used only when the category's
 * shared default is opted in, the same rule as every other category.
 */
export const SOURCE_CREDENTIAL_CATEGORIES = [
  "meta_ad_library",
  "meta_graph",
  "instagram",
  "youtube",
  "search",
  "twitter",
  "linkedin",
  "pinterest",
  "tiktok",
  "licensed",
] as const;

export type SourceCredentialCategory = (typeof SOURCE_CREDENTIAL_CATEGORIES)[number];

/** The deployment variables a source category reads, in order. The first one that is set is the key. */
export const SOURCE_KEY_ENV: Record<SourceCredentialCategory, readonly string[]> = {
  meta_ad_library: ["META_AD_LIBRARY_TOKEN"],
  meta_graph: ["META_ACCESS_TOKEN", "FACEBOOK_ACCESS_TOKEN"],
  instagram: ["INSTAGRAM_ACCESS_TOKEN"],
  youtube: ["YOUTUBE_API_KEY"],
  search: ["SERPAPI_API_KEY", "GOOGLE_SEARCH_API_KEY"],
  twitter: ["TWITTER_BEARER_TOKEN", "X_API_KEY"],
  linkedin: ["LINKEDIN_ACCESS_TOKEN"],
  pinterest: ["PINTEREST_ACCESS_TOKEN"],
  tiktok: ["TIKTOK_ACCESS_TOKEN"],
  licensed: ["LICENSED_DATA_API_KEY", "SENSOR_TOWER_API_KEY"],
};

/** Where a usable key came from. */
export type CredentialSource = "workspace" | "deployment_shared_default";

/**
 * The resolver's answer. `secret` is returned only to the caller that makes the provider request. It is never placed in
 * a settings response, an error message, a log, a run record or an audit entry.
 */
export type CredentialResolution =
  | { status: "ready"; source: CredentialSource; secret: string; fingerprint: string }
  | { status: "unusable"; source: "workspace"; reason: string }
  | { status: "not_configured"; reason: string };

/** The state a settings panel shows. It carries no secret. */
export type CredentialState = {
  state: "usable" | "unusable" | "not_configured";
  source: CredentialSource | null;
  fingerprint: string | null;
  reason: string | null;
};

/** The vault entry type that holds a category's saved key. One row per organization and type. */
export const CREDENTIAL_VAULT_TYPE: Record<CredentialCategory, string> = {
  perception: "provider_config:perception",
  jev: "provider_config:jev",
  production: "provider_config:production",
  openai: "provider_config:openai",
  hypit: "provider_config:hypit",
  meta_ad_library: "provider_config:source:meta_ad_library",
  meta_graph: "provider_config:source:meta_graph",
  instagram: "provider_config:source:instagram",
  youtube: "provider_config:source:youtube",
  search: "provider_config:source:search",
  twitter: "provider_config:source:twitter",
  linkedin: "provider_config:source:linkedin",
  pinterest: "provider_config:source:pinterest",
  tiktok: "provider_config:source:tiktok",
  licensed: "provider_config:source:licensed",
};

/**
 * The deployment variable that makes the deployment's own key a shared default for a category. Without the variable set to
 * its accepted value, a deployment key is never used for that category.
 */
export const SHARED_DEFAULT_ENV: Record<CredentialCategory, { variable: string; accepts: string }> = {
  perception: { variable: "PERCEPTION_SHARED_DEFAULT", accepts: "gemini" },
  jev: { variable: "JEV_SHARED_DEFAULT", accepts: "deployment" },
  production: { variable: "PRODUCTION_SHARED_DEFAULT", accepts: "deployment" },
  openai: { variable: "OPENAI_SHARED_DEFAULT", accepts: "deployment" },
  hypit: { variable: "HYPIT_SHARED_DEFAULT", accepts: "deployment" },
  meta_ad_library: { variable: "META_AD_LIBRARY_SHARED_DEFAULT", accepts: "deployment" },
  meta_graph: { variable: "META_GRAPH_SHARED_DEFAULT", accepts: "deployment" },
  instagram: { variable: "INSTAGRAM_SHARED_DEFAULT", accepts: "deployment" },
  youtube: { variable: "YOUTUBE_SHARED_DEFAULT", accepts: "deployment" },
  search: { variable: "SEARCH_SHARED_DEFAULT", accepts: "deployment" },
  twitter: { variable: "TWITTER_SHARED_DEFAULT", accepts: "deployment" },
  linkedin: { variable: "LINKEDIN_SHARED_DEFAULT", accepts: "deployment" },
  pinterest: { variable: "PINTEREST_SHARED_DEFAULT", accepts: "deployment" },
  tiktok: { variable: "TIKTOK_SHARED_DEFAULT", accepts: "deployment" },
  licensed: { variable: "LICENSED_SHARED_DEFAULT", accepts: "deployment" },
};

/**
 * A deployment key with no workspace entry. Its callers run for the whole deployment, with no workspace in scope, so the
 * key is used only when its opt-in variable is set to `accepts`. It is read by the same resolver, and it is not a saved
 * category. The OpenRouter chat path (providers/chat.server.ts) is the one such key.
 */
export const DEPLOYMENT_ONLY_KEY_ENV = {
  openrouter_chat: { keyVariable: "OPENROUTER_API_KEY", variable: "OPENROUTER_SHARED_DEFAULT", accepts: "deployment" },
} as const;

export type DeploymentOnlyKey = keyof typeof DEPLOYMENT_ONLY_KEY_ENV;

/** The masked fingerprint shown in settings. Four characters are shown only when at least half the key stays hidden. */
export function credentialFingerprint(secret: string): string | null {
  return secret.length >= 8 ? `...${secret.slice(-4)}` : null;
}

/** Turns a resolution into the state a settings panel shows. Pure. */
export function credentialStateOf(resolution: CredentialResolution): CredentialState {
  if (resolution.status === "ready") {
    return { state: "usable", source: resolution.source, fingerprint: resolution.fingerprint, reason: null };
  }
  if (resolution.status === "unusable") {
    return { state: "unusable", source: "workspace", fingerprint: null, reason: resolution.reason };
  }
  return { state: "not_configured", source: null, fingerprint: null, reason: resolution.reason };
}
