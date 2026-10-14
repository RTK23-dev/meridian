// HeyGen Avatar IV via OpenRouter (Bible 10.3 avatar; Bible 20.3 item 3). There is no verified API for it: PROVIDER_APIS.md has
// no avatar section, and the vendor's clip length, lip-sync with an external voice and concurrency are open. So this adapter
// reports NOT_CONNECTED and sends nothing. It stays in the registry so that the route can be verified later without new code.

import { EngineError } from "../../contracts/errors.ts";
import type { AssetSpec, ProviderPoll } from "../../contracts/assets.ts";
import type { ResolvedRoute } from "../../gateway/gateway.ts";
import { listPriceUsd, UNVERIFIED_CAPABILITIES, type AdapterConnection, type RoutedAdapter } from "../adapter.ts";

export const AVATAR_NOT_CONNECTED =
  "NOT_CONNECTED: HeyGen Avatar IV via OpenRouter has no verified API (PROVIDER_APIS.md has no avatar section; Bible 20.3 item 3). No request is made.";

/** The avatar adapter. Its connection is always false, and submit and poll refuse without a call. */
export function avatarIvAdapter(route: ResolvedRoute): RoutedAdapter {
  if (route.capability !== "avatar") throw new EngineError("config", `avatarIvAdapter cannot serve ${route.capability}`);
  return {
    id: `${route.provider.id}:${route.model ?? "avatar-iv-unrouted"}`,
    providerId: route.provider.id,
    modelClass: "avatar",
    capabilities: UNVERIFIED_CAPABILITIES,

    price(spec: AssetSpec) {
      return { estimateUsd: listPriceUsd(route.priceKey, "per_second", spec.durationMs / 1000) };
    },

    async connection(): Promise<AdapterConnection> {
      return { connected: false, reason: AVATAR_NOT_CONNECTED };
    },

    async submit(): Promise<{ jobRef: string }> {
      throw new EngineError("config", AVATAR_NOT_CONNECTED);
    },

    async poll(): Promise<ProviderPoll> {
      return { state: "failed", error: { kind: "unknown", retryable: false, message: AVATAR_NOT_CONNECTED } };
    },

    detailsFor() {
      return undefined;
    },
  };
}
