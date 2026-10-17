// The connector to Meridian's credential resolver (src/lib/meridian/credentials/resolve.ts), the one place keys are read.
// The engine never reads a key from the environment; this source asks the resolver at the moment of each call.
//
// The credential ids `openrouter`, `heygen`, `anthropic`, `deepgram` and `apify` are Meridian's workspace credential categories of the
// same names. With an organization in scope, each is resolved for that workspace only (resolveCredential): the workspace's own
// key first, an unusable saved key never replaced by the deployment key, and the deployment key only with its opt-in.
// With no organization in scope, no workspace key is ever read: OpenRouter falls back to the deployment-only chat key
// (DEPLOYMENT_ONLY_KEY_ENV.openrouter_chat, used when OPENROUTER_SHARED_DEFAULT=deployment), and the others are not connected.

import type { CredentialLookup, CredentialSource } from "./types.ts";

type Resolution = { status: "ready"; secret: string } | { status: "unusable" | "not_configured"; reason: string };

/** The workspace categories this connector maps. The credential id and the category have the same name. */
export type MeridianWorkspaceCategory = "openrouter" | "heygen" | "anthropic" | "deepgram" | "apify";

const CATEGORY_OF: Record<string, MeridianWorkspaceCategory> = {
  openrouter: "openrouter",
  heygen: "heygen",
  anthropic: "anthropic",
  deepgram: "deepgram",
  apify: "apify",
};

const LABEL: Record<MeridianWorkspaceCategory, string> = {
  openrouter: "OpenRouter",
  heygen: "HeyGen",
  anthropic: "Anthropic",
  deepgram: "Deepgram",
  apify: "Apify",
};

export type MeridianResolver = {
  /** The deployment-only key, for a call with no workspace in scope. */
  deploymentOnly(key: "openrouter_chat"): Promise<Resolution>;
  /** One workspace's key for one category, through resolveCredential. */
  workspace(organizationId: string, category: MeridianWorkspaceCategory): Promise<Resolution>;
};

async function defaultResolver(): Promise<MeridianResolver> {
  // Loaded only when a call needs a key, so importing the gateway starts no database.
  const { loadDefaultSql, resolveCredential, resolveDeploymentOnlyKey } = await import("../../lib/meridian/credentials/resolve.ts");
  return {
    deploymentOnly: async (key) => resolveDeploymentOnlyKey(key),
    workspace: async (organizationId, category) => resolveCredential(await loadDefaultSql(), organizationId, category),
  };
}

function lookup(resolution: Resolution): CredentialLookup {
  if (resolution.status === "ready") return { status: "ready", credential: { kind: "api_key", secret: resolution.secret } };
  return { status: "not_connected", reason: resolution.reason };
}

/** Meridian's credentials as a gateway CredentialSource. Tests pass a resolver; production uses the real one. */
export function meridianCredentialSource(resolver?: MeridianResolver): CredentialSource {
  const load = resolver ? async () => resolver : defaultResolver;
  return {
    async get(credentialId, organizationId) {
      const category = Object.hasOwn(CATEGORY_OF, credentialId) ? CATEGORY_OF[credentialId] : undefined;
      if (!category) {
        return {
          status: "not_connected",
          reason: `Meridian has no credential category for ${credentialId}, so the engine cannot call it.`,
        };
      }
      const label = LABEL[category];
      const scope = typeof organizationId === "string" ? organizationId.trim() : "";
      try {
        if (scope) return lookup(await (await load()).workspace(scope, category));
        // No workspace in scope: a workspace key is never read. Only OpenRouter has a deployment-only key.
        if (category === "openrouter") return lookup(await (await load()).deploymentOnly("openrouter_chat"));
        return { status: "not_connected", reason: `No workspace is in scope, so no ${label} key can be used.` };
      } catch {
        return { status: "not_connected", reason: `The ${label} credential could not be checked, so no request is made.` };
      }
    },
  };
}
