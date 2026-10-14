// The connector to Meridian's credential resolver (src/lib/meridian/credentials/resolve.ts), the one place keys are read.
// The engine never reads a key from the environment; this source asks the resolver at the moment of each call.
//
// Today Meridian knows the OpenRouter key only as a deployment-wide key (DEPLOYMENT_ONLY_KEY_ENV.openrouter_chat, used when
// OPENROUTER_SHARED_DEFAULT=deployment), and has no HeyGen or Anthropic category. Those are not connected until a category
// exists; adding one is a change to the credential contract, which is the owner's call (STATUS.md).

import type { CredentialLookup, CredentialSource } from "./types.ts";

type Resolution = { status: "ready"; secret: string } | { status: "unusable" | "not_configured"; reason: string };

export type MeridianResolver = {
  deploymentOnly(key: "openrouter_chat"): Promise<Resolution>;
};

async function defaultResolver(): Promise<MeridianResolver> {
  const { resolveDeploymentOnlyKey } = await import("../../lib/meridian/credentials/resolve.ts");
  return { deploymentOnly: async (key) => resolveDeploymentOnlyKey(key) };
}

function lookup(resolution: Resolution): CredentialLookup {
  if (resolution.status === "ready") return { status: "ready", credential: { kind: "api_key", secret: resolution.secret } };
  return { status: "not_connected", reason: resolution.reason };
}

/** Meridian's credentials as a gateway CredentialSource. Tests pass a resolver; production uses the real one. */
export function meridianCredentialSource(resolver?: MeridianResolver): CredentialSource {
  const load = resolver ? async () => resolver : defaultResolver;
  return {
    async get(credentialId) {
      if (credentialId === "openrouter") {
        try {
          return lookup(await (await load()).deploymentOnly("openrouter_chat"));
        } catch {
          return { status: "not_connected", reason: "The OpenRouter credential could not be checked, so no request is made." };
        }
      }
      return {
        status: "not_connected",
        reason: `Meridian has no credential category for ${credentialId} yet, so the engine cannot call it.`,
      };
    },
  };
}
